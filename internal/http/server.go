package httpserver

import (
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"strconv"
	"strings"
	"time"

	"docker-reader/internal/auth"
	"docker-reader/internal/library"
	"docker-reader/internal/notes"
	"docker-reader/internal/storage"
)

type Server struct {
	auth      *auth.Service
	library   *library.Service
	notes     *notes.Service
	recents   storage.RecentStore
	progress  storage.ProgressStore
	staticFS  fs.FS
	maxUpload int64
}

func New(authSvc *auth.Service, libSvc *library.Service, notesSvc *notes.Service, recentStore storage.RecentStore, progressStore storage.ProgressStore, staticFS fs.FS) *Server {
	return &Server{
		auth:      authSvc,
		library:   libSvc,
		notes:     notesSvc,
		recents:   recentStore,
		progress:  progressStore,
		staticFS:  staticFS,
		maxUpload: 64 << 20,
	}
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("POST /api/login", s.handleLogin)
	mux.HandleFunc("POST /api/logout", s.withAuth(s.handleLogout))
	mux.HandleFunc("GET /api/me", s.withAuth(s.handleMe))
	mux.HandleFunc("GET /api/search", s.withAuth(s.handleSearch))
	mux.HandleFunc("GET /api/library", s.withAuth(s.handleLibrary))
	mux.HandleFunc("GET /api/recent", s.withAuth(s.handleRecent))
	mux.HandleFunc("GET /api/doc/{id}", s.withAuth(s.handleDocMeta))
	mux.HandleFunc("GET /api/doc/{id}/file", s.withAuth(s.handleDocFile))
	mux.HandleFunc("GET /api/doc/{id}/progress", s.withAuth(s.handleGetProgress))
	mux.HandleFunc("POST /api/doc/{id}/progress", s.withAuth(s.handleSetProgress))
	mux.HandleFunc("GET /api/doc/{id}/notes", s.withAuth(s.handleNotesList))
	mux.HandleFunc("GET /api/doc/{id}/notes/{noteId}", s.withAuth(s.handleNotesGet))
	mux.HandleFunc("POST /api/doc/{id}/notes", s.withAuth(s.handleNotesCreate))
	mux.HandleFunc("PUT /api/doc/{id}/notes/{noteId}", s.withAuth(s.handleNotesUpdate))
	mux.HandleFunc("DELETE /api/doc/{id}/notes/{noteId}", s.withAuth(s.handleNotesDelete))
	mux.HandleFunc("POST /api/upload", s.withAuth(s.handleUpload))

	fileServer := http.FileServer(http.FS(s.staticFS))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
			return
		}

		normalized := path.Clean(strings.TrimPrefix(r.URL.Path, "/"))
		if normalized == "." || normalized == "" {
			w.Header().Set("Cache-Control", "no-store")
			http.ServeFileFS(w, r, s.staticFS, "index.html")
			return
		}

		if strings.Contains(normalized, ".") {
			w.Header().Set("Cache-Control", "no-store")
			fileServer.ServeHTTP(w, r)
			return
		}

		w.Header().Set("Cache-Control", "no-store")
		http.ServeFileFS(w, r, s.staticFS, "index.html")
	})

	return logRequests(mux)
}

// openDocIDForResume picks the document the user most recently engaged with on any device.
// Recents (opened_at) updates when the PDF is fetched; reading_focus updates when progress is saved.
// Using only one source caused mobile to stick on a stale focus while desktop kept recents in sync.
func (s *Server) openDocIDForResume(userID int64) (docID string, ok bool, err error) {
	var fromRecent string
	var recentAt time.Time
	var haveRecent bool
	items, err := s.recents.ListRecent(userID, 40)
	if err != nil {
		return "", false, err
	}
	for _, it := range items {
		if _, _, resErr := s.library.ResolveDocument(it.DocID); resErr != nil {
			continue
		}
		fromRecent = it.DocID
		recentAt = it.LastOpened
		haveRecent = true
		break
	}

	focusID, focusAt, haveFocus, perr := s.progress.GetReadingFocusWithTime(userID)
	if perr != nil {
		return "", false, perr
	}
	if haveFocus {
		if _, _, resErr := s.library.ResolveDocument(focusID); resErr != nil {
			haveFocus = false
		}
	}

	switch {
	case haveRecent && haveFocus:
		if focusAt.After(recentAt) {
			return focusID, true, nil
		}
		return fromRecent, true, nil
	case haveRecent:
		return fromRecent, true, nil
	case haveFocus:
		return focusID, true, nil
	default:
		return "", false, nil
	}
}

func (s *Server) withAuth(next func(http.ResponseWriter, *http.Request, *storage.User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		user, err := s.auth.CurrentUser(r)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "auth failed"})
			return
		}
		if user == nil {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		next(w, r, user)
	}
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	type request struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}

	user, err := s.auth.Authenticate(strings.TrimSpace(req.Username), req.Password)
	if err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid credentials"})
		return
	}

	if err := s.auth.StartSession(w, user); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not start session"})
		return
	}

	loginPayload := map[string]any{
		"user": map[string]any{
			"id":       user.ID,
			"username": user.Username,
		},
	}
	if docID, ok, err := s.openDocIDForResume(user.ID); err == nil && ok {
		loginPayload["openDocId"] = docID
	} else {
		loginPayload["openDocId"] = nil
	}
	writeJSON(w, http.StatusOK, loginPayload)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request, _ *storage.User) {
	if err := s.auth.EndSession(w, r); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not end session"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

func (s *Server) handleMe(w http.ResponseWriter, _ *http.Request, user *storage.User) {
	payload := map[string]any{
		"id":       user.ID,
		"username": user.Username,
		"openDocId": nil,
	}
	if docID, ok, err := s.openDocIDForResume(user.ID); err == nil && ok {
		payload["openDocId"] = docID
	}
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) handleSearch(w http.ResponseWriter, r *http.Request, _ *storage.User) {
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	docs, err := s.library.Search(query, 200)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "search failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"documents": docs})
}

func (s *Server) handleLibrary(w http.ResponseWriter, _ *http.Request, _ *storage.User) {
	docs, err := s.library.ListAll(200)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "library listing failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"documents": docs})
}

func (s *Server) handleRecent(w http.ResponseWriter, _ *http.Request, user *storage.User) {
	recents, err := s.recents.ListRecent(user.ID, 40)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "recent lookup failed"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": recents})
}

func (s *Server) handleDocMeta(w http.ResponseWriter, r *http.Request, _ *storage.User) {
	docID := r.PathValue("id")
	doc, _, err := s.library.ResolveDocument(docID)
	if errors.Is(err, fs.ErrNotExist) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "document not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "document lookup failed"})
		return
	}
	writeJSON(w, http.StatusOK, doc)
}

func (s *Server) handleDocFile(w http.ResponseWriter, r *http.Request, user *storage.User) {
	docID := r.PathValue("id")
	doc, fullPath, err := s.library.ResolveDocument(docID)
	if errors.Is(err, fs.ErrNotExist) {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "document not found"})
		return
	}
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "document lookup failed"})
		return
	}

	file, err := os.Open(fullPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "open failed"})
		return
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "stat failed"})
		return
	}

	// PDF.js uses many ranged GETs; waiting on SQLite here for each request blocks byte delivery (MaxOpenConns=1).
	u, docIDForRecent, title := user.ID, doc.ID, doc.Title
	go func() {
		_ = s.recents.TouchRecent(u, docIDForRecent, title, time.Now())
	}()

	w.Header().Set("Content-Type", "application/pdf")
	w.Header().Set("Cache-Control", "private, max-age=120")
	http.ServeContent(w, r, info.Name(), info.ModTime(), file)
}

const progressZoomMin = 50
const progressZoomMax = 300

func (s *Server) handleGetProgress(w http.ResponseWriter, r *http.Request, user *storage.User) {
	docID := r.PathValue("id")
	entry, err := s.progress.GetProgress(user.ID, docID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "progress lookup failed"})
		return
	}
	if entry == nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"page":         1,
			"zoomPercent":  100,
			"scrollTop":    0.0,
			"scrollLeft":   0.0,
		})
		return
	}
	writeJSON(w, http.StatusOK, entry)
}

func (s *Server) handleSetProgress(w http.ResponseWriter, r *http.Request, user *storage.User) {
	docID := r.PathValue("id")
	type request struct {
		Page         int     `json:"page"`
		ZoomPercent  int     `json:"zoomPercent"`
		ScrollTop    float64 `json:"scrollTop"`
		ScrollLeft   float64 `json:"scrollLeft"`
	}
	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if req.Page < 1 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid page"})
		return
	}
	zoom := req.ZoomPercent
	if zoom < progressZoomMin {
		zoom = progressZoomMin
	}
	if zoom > progressZoomMax {
		zoom = progressZoomMax
	}
	if req.ScrollTop < 0 {
		req.ScrollTop = 0
	}
	if req.ScrollLeft < 0 {
		req.ScrollLeft = 0
	}
	wr := storage.ProgressWrite{
		Page:         req.Page,
		ZoomPercent:  zoom,
		ScrollTop:    req.ScrollTop,
		ScrollLeft:   req.ScrollLeft,
	}
	if err := s.progress.SetProgress(user.ID, docID, wr, time.Now()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not save progress"})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"page":         wr.Page,
		"zoomPercent":  wr.ZoomPercent,
		"scrollTop":    wr.ScrollTop,
		"scrollLeft":   wr.ScrollLeft,
	})
}

func (s *Server) handleUpload(w http.ResponseWriter, r *http.Request, user *storage.User) {
	r.Body = http.MaxBytesReader(w, r.Body, s.maxUpload)
	if err := r.ParseMultipartForm(s.maxUpload); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid multipart upload"})
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "missing file field"})
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "upload read failed"})
		return
	}

	doc, err := s.library.StoreUpload(header.Filename, data)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "upload save failed"})
		return
	}

	if err := s.recents.TouchRecent(user.ID, doc.ID, doc.Title, time.Now()); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "could not save recent"})
		return
	}

	writeJSON(w, http.StatusCreated, map[string]any{"document": doc})
}

func (s *Server) writeNotesError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, notes.ErrDocNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "document not found"})
	case errors.Is(err, notes.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "note not found"})
	case errors.Is(err, notes.ErrInvalidNoteID):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid note id"})
	case errors.Is(err, notes.ErrInvalidPage):
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid page"})
	case errors.Is(err, notes.ErrNoteTooLarge):
		writeJSON(w, http.StatusRequestEntityTooLarge, map[string]string{"error": "note too large"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "notes operation failed"})
	}
}

func (s *Server) handleNotesList(w http.ResponseWriter, r *http.Request, user *storage.User) {
	docID := r.PathValue("id")
	q := r.URL.Query().Get("q")
	pageFilter := 0
	if ps := strings.TrimSpace(r.URL.Query().Get("page")); ps != "" {
		p, err := strconv.Atoi(ps)
		if err != nil || p < 1 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid page filter"})
			return
		}
		pageFilter = p
	}
	items, err := s.notes.List(user.ID, docID, q, pageFilter)
	if err != nil {
		s.writeNotesError(w, err)
		return
	}
	if items == nil {
		items = []notes.NoteMeta{}
	}
	writeJSON(w, http.StatusOK, map[string]any{"notes": items})
}

func (s *Server) handleNotesGet(w http.ResponseWriter, r *http.Request, user *storage.User) {
	docID := r.PathValue("id")
	noteID := r.PathValue("noteId")
	body, err := s.notes.Get(user.ID, docID, noteID)
	if err != nil {
		s.writeNotesError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"body": body})
}

func (s *Server) handleNotesCreate(w http.ResponseWriter, r *http.Request, user *storage.User) {
	docID := r.PathValue("id")
	type request struct {
		Page int    `json:"page"`
		Body string `json:"body"`
	}
	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	id, err := s.notes.Create(user.ID, docID, req.Page, req.Body)
	if err != nil {
		s.writeNotesError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"id": id, "page": req.Page})
}

func (s *Server) handleNotesUpdate(w http.ResponseWriter, r *http.Request, user *storage.User) {
	docID := r.PathValue("id")
	noteID := r.PathValue("noteId")
	type request struct {
		Body string `json:"body"`
	}
	var req request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid json"})
		return
	}
	if err := s.notes.Update(user.ID, docID, noteID, req.Body); err != nil {
		s.writeNotesError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

func (s *Server) handleNotesDelete(w http.ResponseWriter, r *http.Request, user *storage.User) {
	docID := r.PathValue("id")
	noteID := r.PathValue("noteId")
	if err := s.notes.Delete(user.ID, docID, noteID); err != nil {
		s.writeNotesError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"ok": "true"})
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
