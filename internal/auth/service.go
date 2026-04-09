package auth

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"net/http"
	"time"

	"golang.org/x/crypto/bcrypt"
	"docker-reader/internal/storage"
)

type contextKey string

const userContextKey contextKey = "auth_user"

type Service struct {
	users      storage.UserStore
	sessions   storage.SessionStore
	cookieName string
	sessionTTL time.Duration
}

func NewService(users storage.UserStore, sessions storage.SessionStore, cookieName string, sessionTTL time.Duration) *Service {
	return &Service{
		users:      users,
		sessions:   sessions,
		cookieName: cookieName,
		sessionTTL: sessionTTL,
	}
}

func HashPassword(password string) (string, error) {
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	return string(hash), err
}

func (s *Service) SeedUsers(entries []storage.User) error {
	for _, user := range entries {
		if err := s.users.UpsertUser(user.Username, user.PasswordHash); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) Authenticate(username, password string) (*storage.User, error) {
	user, err := s.users.GetUserByUsername(username)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errors.New("invalid credentials")
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, errors.New("invalid credentials")
	}
	return user, nil
}

func (s *Service) StartSession(w http.ResponseWriter, user *storage.User) error {
	token, err := randomToken(32)
	if err != nil {
		return err
	}

	expiresAt := time.Now().Add(s.sessionTTL)
	if err := s.sessions.CreateSession(token, user.ID, expiresAt); err != nil {
		return err
	}

	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   false,
		SameSite: http.SameSiteLaxMode,
		Expires:  expiresAt,
	})

	return nil
}

func (s *Service) EndSession(w http.ResponseWriter, r *http.Request) error {
	cookie, err := r.Cookie(s.cookieName)
	if err == nil && cookie.Value != "" {
		if derr := s.sessions.DeleteSession(cookie.Value); derr != nil {
			return derr
		}
	}

	http.SetCookie(w, &http.Cookie{
		Name:     s.cookieName,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})
	return nil
}

func (s *Service) CurrentUser(r *http.Request) (*storage.User, error) {
	cookie, err := r.Cookie(s.cookieName)
	if err != nil || cookie.Value == "" {
		return nil, nil
	}

	session, err := s.sessions.GetSession(cookie.Value)
	if err != nil {
		return nil, err
	}
	if session == nil || session.ExpiresAt.Before(time.Now()) {
		return nil, nil
	}

	user, err := s.users.GetUserByID(session.UserID)
	if err != nil {
		return nil, err
	}
	return user, nil
}

func UserFromContext(ctx context.Context) (*storage.User, bool) {
	user, ok := ctx.Value(userContextKey).(*storage.User)
	return user, ok
}

func ContextWithUser(ctx context.Context, user *storage.User) context.Context {
	return context.WithValue(ctx, userContextKey, user)
}

func randomToken(numBytes int) (string, error) {
	buf := make([]byte, numBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}
