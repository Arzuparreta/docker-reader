package storage

import "time"

type User struct {
	ID           int64  `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"-"`
}

type Session struct {
	Token     string
	UserID    int64
	ExpiresAt time.Time
}

type RecentEntry struct {
	DocID      string    `json:"docId"`
	Title      string    `json:"title"`
	LastOpened time.Time `json:"lastOpened"`
}

type ProgressEntry struct {
	DocID         string    `json:"docId,omitempty"`
	Page          int       `json:"page"`
	ZoomPercent   int       `json:"zoomPercent"`
	ScrollTop     float64   `json:"scrollTop"`
	ScrollLeft    float64   `json:"scrollLeft"`
	UpdatedAt     time.Time `json:"updatedAt,omitempty"`
}

// ProgressWrite is viewer state for SetProgress (last-write-wins per user+doc).
type ProgressWrite struct {
	Page         int
	ZoomPercent  int
	ScrollTop    float64
	ScrollLeft   float64
}

type UserStore interface {
	UpsertUser(username, passwordHash string) error
	GetUserByUsername(username string) (*User, error)
	GetUserByID(id int64) (*User, error)
}

type SessionStore interface {
	CreateSession(token string, userID int64, expiresAt time.Time) error
	GetSession(token string) (*Session, error)
	DeleteSession(token string) error
	DeleteExpiredSessions(now time.Time) error
}

type RecentStore interface {
	TouchRecent(userID int64, docID, title string, openedAt time.Time) error
	ListRecent(userID int64, limit int) ([]RecentEntry, error)
}

type HighlightsStore interface{}

type ProgressStore interface {
	SetProgress(userID int64, docID string, w ProgressWrite, updatedAt time.Time) error
	GetProgress(userID int64, docID string) (*ProgressEntry, error)
	GetReadingFocus(userID int64) (docID string, ok bool, err error)
	GetReadingFocusWithTime(userID int64) (docID string, updatedAt time.Time, ok bool, err error)
}
