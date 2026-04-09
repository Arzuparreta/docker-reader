package main

import (
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"docker-reader/internal/auth"
	"docker-reader/internal/config"
	httpserver "docker-reader/internal/http"
	"docker-reader/internal/library"
	"docker-reader/internal/notes"
	"docker-reader/internal/storage"
	"docker-reader/internal/storage/sqlite"
	webassets "docker-reader/web"
)

func main() {
	dataDir := envOrDefault("DATA_DIR", "./data")
	configPath := envOrDefault("CONFIG", filepath.Join(dataDir, "config.json"))

	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		log.Fatalf("could not create data dir: %v", err)
	}
	uploadsRoot := filepath.Join(dataDir, "uploads")
	if err := os.MkdirAll(uploadsRoot, 0o755); err != nil {
		log.Fatalf("could not create uploads dir: %v", err)
	}
	notesRoot := filepath.Join(dataDir, "notes")
	if err := os.MkdirAll(notesRoot, 0o755); err != nil {
		log.Fatalf("could not create notes dir: %v", err)
	}

	cfg, err := config.Load(configPath)
	if err != nil {
		log.Fatalf("could not load config: %v", err)
	}

	store, err := sqlite.Open(filepath.Join(dataDir, "reader.db"))
	if err != nil {
		log.Fatalf("could not open sqlite: %v", err)
	}
	defer store.Close()

	if err := seedUsers(store, cfg.Users); err != nil {
		log.Fatalf("could not seed users: %v", err)
	}

	authSvc := auth.NewService(store, store, cfg.SessionCookieName, 15*24*time.Hour)
	libSvc := library.NewService(uploadsRoot)
	notesSvc := notes.New(notesRoot, libSvc)

	staticFS, err := fs.Sub(webassets.Dist, "dist")
	if err != nil {
		log.Fatalf("could not prepare static assets: %v", err)
	}

	server := httpserver.New(authSvc, libSvc, notesSvc, store, store, staticFS)
	log.Printf("Docker Reader listening on %s", cfg.Addr)

	if err := http.ListenAndServe(cfg.Addr, server.Routes()); err != nil {
		log.Fatal(err)
	}
}

func seedUsers(store storage.UserStore, users []config.User) error {
	for _, rawUser := range users {
		if rawUser.Username == "" || rawUser.Password == "" {
			continue
		}
		hash, err := auth.HashPassword(rawUser.Password)
		if err != nil {
			return err
		}
		if err := store.UpsertUser(rawUser.Username, hash); err != nil {
			return err
		}
	}
	return nil
}

func envOrDefault(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
