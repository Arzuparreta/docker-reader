package notes

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"docker-reader/internal/library"
)

const maxNoteBytes = 256 << 10

// noteFilenameRe: p + zero-padded page + _ + 12 hex chars + .md
var noteFilenameRe = regexp.MustCompile(`^p(\d+)_([a-f0-9]{12})\.md$`)

var validNoteIDRe = regexp.MustCompile(`^p\d+_[a-f0-9]{12}$`)

var (
	ErrNotFound       = errors.New("note not found")
	ErrInvalidNoteID  = errors.New("invalid note id")
	ErrDocNotFound    = errors.New("document not found")
	ErrNoteTooLarge   = errors.New("note body too large")
	ErrInvalidPage    = errors.New("invalid page")
)

type Service struct {
	root string
	lib  *library.Service
}

func New(root string, lib *library.Service) *Service {
	return &Service{root: root, lib: lib}
}

type NoteMeta struct {
	ID      string `json:"id"`
	Page    int    `json:"page"`
	Preview string `json:"preview"`
}

func (s *Service) ensureDocExists(docID string) error {
	_, _, err := s.lib.ResolveDocument(docID)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrDocNotFound
		}
		return err
	}
	return nil
}

func userDocDir(root string, userID int64, docID string) (string, error) {
	if docID == "" || strings.Contains(docID, string(filepath.Separator)) || strings.Contains(docID, "..") {
		return "", ErrDocNotFound
	}
	uid := strconv.FormatInt(userID, 10)
	if uid == "" || uid == ".." {
		return "", ErrDocNotFound
	}
	return filepath.Join(root, uid, docID), nil
}

func parseNoteFilename(name string) (page int, hexID string, ok bool) {
	m := noteFilenameRe.FindStringSubmatch(name)
	if m == nil {
		return 0, "", false
	}
	p, err := strconv.Atoi(m[1])
	if err != nil || p < 1 {
		return 0, "", false
	}
	return p, m[2], true
}

func noteIDFromFile(name string) (string, bool) {
	if !strings.HasSuffix(name, ".md") {
		return "", false
	}
	stem := strings.TrimSuffix(name, ".md")
	if !noteFilenameRe.MatchString(name) {
		return "", false
	}
	return stem, true
}

func previewFromBody(body string) string {
	body = strings.TrimSpace(body)
	if body == "" {
		return ""
	}
	line := body
	if i := strings.IndexByte(body, '\n'); i >= 0 {
		line = strings.TrimSpace(body[:i])
	}
	line = strings.TrimSpace(line)
	if line == "" {
		return ""
	}
	const maxRunes = 120
	if utf8.RuneCountInString(line) <= maxRunes {
		return line
	}
	runes := []rune(line)
	return string(runes[:maxRunes]) + "…"
}

func (s *Service) List(userID int64, docID string, query string, pageFilter int) ([]NoteMeta, error) {
	if err := s.ensureDocExists(docID); err != nil {
		return nil, err
	}
	dir, err := userDocDir(s.root, userID, docID)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	queryLower := strings.ToLower(strings.TrimSpace(query))
	var out []NoteMeta
	for _, ent := range entries {
		if ent.IsDir() {
			continue
		}
		name := ent.Name()
		id, ok := noteIDFromFile(name)
		if !ok {
			continue
		}
		page, _, ok := parseNoteFilename(name)
		if !ok {
			continue
		}
		if pageFilter > 0 && page != pageFilter {
			continue
		}
		full := filepath.Join(dir, name)
		body, err := os.ReadFile(full)
		if err != nil {
			continue
		}
		if len(body) > maxNoteBytes {
			continue
		}
		text := string(body)
		if queryLower != "" && !strings.Contains(strings.ToLower(text), queryLower) {
			continue
		}
		out = append(out, NoteMeta{
			ID:      id,
			Page:    page,
			Preview: previewFromBody(text),
		})
	}
	sortNoteMeta(out)
	return out, nil
}

func sortNoteMeta(n []NoteMeta) {
	// insertion sort small n
	for i := 1; i < len(n); i++ {
		for j := i; j > 0 && noteMetaLess(n[j], n[j-1]); j-- {
			n[j], n[j-1] = n[j-1], n[j]
		}
	}
}

func noteMetaLess(a, b NoteMeta) bool {
	if a.Page != b.Page {
		return a.Page < b.Page
	}
	return a.ID < b.ID
}

func (s *Service) Get(userID int64, docID, noteID string) (string, error) {
	if err := validateNoteID(noteID); err != nil {
		return "", err
	}
	if err := s.ensureDocExists(docID); err != nil {
		return "", err
	}
	dir, err := userDocDir(s.root, userID, docID)
	if err != nil {
		return "", err
	}
	filename := noteID + ".md"
	full := filepath.Join(dir, filename)
	body, err := os.ReadFile(full)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return "", ErrNotFound
		}
		return "", err
	}
	if len(body) > maxNoteBytes {
		return "", ErrNoteTooLarge
	}
	return string(body), nil
}

func validateNoteID(noteID string) error {
	if !validNoteIDRe.MatchString(noteID) {
		return ErrInvalidNoteID
	}
	return nil
}

func (s *Service) Create(userID int64, docID string, page int, body string) (string, error) {
	if page < 1 {
		return "", ErrInvalidPage
	}
	if len(body) > maxNoteBytes {
		return "", ErrNoteTooLarge
	}
	if err := s.ensureDocExists(docID); err != nil {
		return "", err
	}
	dir, err := userDocDir(s.root, userID, docID)
	if err != nil {
		return "", err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	var randBytes [6]byte
	if _, err := rand.Read(randBytes[:]); err != nil {
		return "", err
	}
	hexID := hex.EncodeToString(randBytes[:])
	name := fmt.Sprintf("p%07d_%s.md", page, hexID)
	full := filepath.Join(dir, name)
	if _, err := os.Stat(full); err == nil {
		if _, err := rand.Read(randBytes[:]); err != nil {
			return "", err
		}
		hexID = hex.EncodeToString(randBytes[:])
		name = fmt.Sprintf("p%07d_%s.md", page, hexID)
		full = filepath.Join(dir, name)
	}
	if err := atomicWriteFile(full, []byte(body)); err != nil {
		return "", err
	}
	return strings.TrimSuffix(name, ".md"), nil
}

func atomicWriteFile(path string, data []byte) error {
	dir := filepath.Dir(path)
	f, err := os.CreateTemp(dir, ".note-*.tmp")
	if err != nil {
		return err
	}
	tmpPath := f.Name()
	if _, err := f.Write(data); err != nil {
		_ = f.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

func (s *Service) Update(userID int64, docID, noteID, body string) error {
	if err := validateNoteID(noteID); err != nil {
		return err
	}
	if len(body) > maxNoteBytes {
		return ErrNoteTooLarge
	}
	if err := s.ensureDocExists(docID); err != nil {
		return err
	}
	dir, err := userDocDir(s.root, userID, docID)
	if err != nil {
		return err
	}
	full := filepath.Join(dir, noteID+".md")
	if _, err := os.Stat(full); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	return atomicWriteFile(full, []byte(body))
}

func (s *Service) Delete(userID int64, docID, noteID string) error {
	if err := validateNoteID(noteID); err != nil {
		return err
	}
	if err := s.ensureDocExists(docID); err != nil {
		return err
	}
	dir, err := userDocDir(s.root, userID, docID)
	if err != nil {
		return err
	}
	full := filepath.Join(dir, noteID+".md")
	if err := os.Remove(full); err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return ErrNotFound
		}
		return err
	}
	return nil
}
