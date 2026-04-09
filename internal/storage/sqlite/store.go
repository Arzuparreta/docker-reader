package sqlite

import (
	"database/sql"
	"errors"
	"time"

	_ "modernc.org/sqlite"
	"docker-reader/internal/storage"
)

type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)

	// WAL lets readers (e.g. PDF metadata) proceed while a short write (progress) commits.
	if _, err := db.Exec(`PRAGMA journal_mode=WAL`); err != nil {
		_ = db.Close()
		return nil, err
	}
	if _, err := db.Exec(`PRAGMA synchronous=NORMAL`); err != nil {
		_ = db.Close()
		return nil, err
	}

	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}

	return s, nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate() error {
	schema := `
CREATE TABLE IF NOT EXISTS users (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	username TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
	token TEXT PRIMARY KEY,
	user_id INTEGER NOT NULL,
	expires_at INTEGER NOT NULL,
	created_at INTEGER NOT NULL,
	FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS recents (
	user_id INTEGER NOT NULL,
	doc_id TEXT NOT NULL,
	title TEXT NOT NULL,
	opened_at INTEGER NOT NULL,
	PRIMARY KEY(user_id, doc_id),
	FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_recents_opened ON recents(user_id, opened_at DESC);

CREATE TABLE IF NOT EXISTS progress (
	user_id INTEGER NOT NULL,
	doc_id TEXT NOT NULL,
	page INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	PRIMARY KEY(user_id, doc_id),
	FOREIGN KEY(user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS reading_focus (
	user_id INTEGER NOT NULL PRIMARY KEY,
	doc_id TEXT NOT NULL,
	updated_at INTEGER NOT NULL,
	FOREIGN KEY(user_id) REFERENCES users(id)
);

-- highlights: unused (schema reserved).
CREATE TABLE IF NOT EXISTS highlights (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	user_id INTEGER NOT NULL,
	doc_id TEXT NOT NULL,
	page INTEGER NOT NULL,
	selected_text TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
`
	if _, err := s.db.Exec(schema); err != nil {
		return err
	}
	return s.migrateProgressViewerColumns()
}

func (s *Store) migrateProgressViewerColumns() error {
	cols := []struct {
		name string
		sql  string
	}{
		{"zoom_percent", `ALTER TABLE progress ADD COLUMN zoom_percent INTEGER NOT NULL DEFAULT 100`},
		{"scroll_top", `ALTER TABLE progress ADD COLUMN scroll_top REAL NOT NULL DEFAULT 0`},
		{"scroll_left", `ALTER TABLE progress ADD COLUMN scroll_left REAL NOT NULL DEFAULT 0`},
	}
	for _, col := range cols {
		has, err := s.tableHasColumn("progress", col.name)
		if err != nil {
			return err
		}
		if has {
			continue
		}
		if _, err := s.db.Exec(col.sql); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) tableHasColumn(table, column string) (bool, error) {
	rows, err := s.db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return false, err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, ctype string
		var notnull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return false, err
		}
		if name == column {
			return true, nil
		}
	}
	return false, rows.Err()
}

func (s *Store) UpsertUser(username, passwordHash string) error {
	_, err := s.db.Exec(
		`INSERT INTO users(username, password_hash, created_at)
		 VALUES(?, ?, ?)
		 ON CONFLICT(username) DO UPDATE SET password_hash = excluded.password_hash`,
		username,
		passwordHash,
		time.Now().Unix(),
	)
	return err
}

func (s *Store) GetUserByUsername(username string) (*storage.User, error) {
	var user storage.User
	err := s.db.QueryRow(
		`SELECT id, username, password_hash FROM users WHERE username = ?`,
		username,
	).Scan(&user.ID, &user.Username, &user.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (s *Store) GetUserByID(id int64) (*storage.User, error) {
	var user storage.User
	err := s.db.QueryRow(
		`SELECT id, username, password_hash FROM users WHERE id = ?`,
		id,
	).Scan(&user.ID, &user.Username, &user.PasswordHash)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &user, nil
}

func (s *Store) CreateSession(token string, userID int64, expiresAt time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO sessions(token, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)`,
		token,
		userID,
		expiresAt.Unix(),
		time.Now().Unix(),
	)
	return err
}

func (s *Store) GetSession(token string) (*storage.Session, error) {
	var session storage.Session
	var exp int64
	err := s.db.QueryRow(
		`SELECT token, user_id, expires_at FROM sessions WHERE token = ?`,
		token,
	).Scan(&session.Token, &session.UserID, &exp)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	session.ExpiresAt = time.Unix(exp, 0)
	return &session, nil
}

func (s *Store) DeleteSession(token string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token = ?`, token)
	return err
}

func (s *Store) DeleteExpiredSessions(now time.Time) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE expires_at < ?`, now.Unix())
	return err
}

func (s *Store) TouchRecent(userID int64, docID, title string, openedAt time.Time) error {
	_, err := s.db.Exec(
		`INSERT INTO recents(user_id, doc_id, title, opened_at)
		 VALUES(?, ?, ?, ?)
		 ON CONFLICT(user_id, doc_id) DO UPDATE SET title = excluded.title, opened_at = excluded.opened_at`,
		userID,
		docID,
		title,
		openedAt.Unix(),
	)
	return err
}

func (s *Store) ListRecent(userID int64, limit int) ([]storage.RecentEntry, error) {
	rows, err := s.db.Query(
		`SELECT doc_id, title, opened_at FROM recents WHERE user_id = ? ORDER BY opened_at DESC LIMIT ?`,
		userID,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]storage.RecentEntry, 0, limit)
	for rows.Next() {
		var entry storage.RecentEntry
		var ts int64
		if err := rows.Scan(&entry.DocID, &entry.Title, &ts); err != nil {
			return nil, err
		}
		entry.LastOpened = time.Unix(ts, 0)
		out = append(out, entry)
	}

	return out, rows.Err()
}

func (s *Store) SetProgress(userID int64, docID string, w storage.ProgressWrite, updatedAt time.Time) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	ts := updatedAt.Unix()
	_, err = tx.Exec(
		`INSERT INTO progress(user_id, doc_id, page, updated_at, zoom_percent, scroll_top, scroll_left)
		 VALUES(?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(user_id, doc_id) DO UPDATE SET
		   page = excluded.page,
		   updated_at = excluded.updated_at,
		   zoom_percent = excluded.zoom_percent,
		   scroll_top = excluded.scroll_top,
		   scroll_left = excluded.scroll_left`,
		userID,
		docID,
		w.Page,
		ts,
		w.ZoomPercent,
		w.ScrollTop,
		w.ScrollLeft,
	)
	if err != nil {
		return err
	}
	_, err = tx.Exec(
		`INSERT INTO reading_focus(user_id, doc_id, updated_at) VALUES(?, ?, ?)
		 ON CONFLICT(user_id) DO UPDATE SET doc_id = excluded.doc_id, updated_at = excluded.updated_at`,
		userID,
		docID,
		ts,
	)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) GetProgress(userID int64, docID string) (*storage.ProgressEntry, error) {
	var entry storage.ProgressEntry
	var updatedAt int64
	err := s.db.QueryRow(
		`SELECT doc_id, page, zoom_percent, scroll_top, scroll_left, updated_at
		 FROM progress WHERE user_id = ? AND doc_id = ?`,
		userID,
		docID,
	).Scan(
		&entry.DocID,
		&entry.Page,
		&entry.ZoomPercent,
		&entry.ScrollTop,
		&entry.ScrollLeft,
		&updatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	entry.UpdatedAt = time.Unix(updatedAt, 0)
	return &entry, nil
}

func (s *Store) GetReadingFocusWithTime(userID int64) (docID string, updatedAt time.Time, ok bool, err error) {
	var id string
	var ts int64
	err = s.db.QueryRow(`SELECT doc_id, updated_at FROM reading_focus WHERE user_id = ?`, userID).Scan(&id, &ts)
	if errors.Is(err, sql.ErrNoRows) {
		return "", time.Time{}, false, nil
	}
	if err != nil {
		return "", time.Time{}, false, err
	}
	return id, time.Unix(ts, 0), true, nil
}

func (s *Store) GetReadingFocus(userID int64) (docID string, ok bool, err error) {
	id, _, ok, err := s.GetReadingFocusWithTime(userID)
	return id, ok, err
}
