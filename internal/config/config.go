package config

import (
	"encoding/json"
	"errors"
	"os"
)

type User struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

type Config struct {
	Addr              string `json:"addr"`
	SessionSecret     string `json:"sessionSecret"`
	SessionCookieName string `json:"sessionCookieName"`
	Users             []User `json:"users"`
}

func Default() Config {
	return Config{
		Addr:              ":8080",
		SessionCookieName: "docker_reader_session",
		SessionSecret:     "replace-me",
		Users: []User{
			{Username: "reader", Password: "reader"},
		},
	}
}

func Load(path string) (Config, error) {
	cfg := Default()
	if path == "" {
		return cfg, nil
	}

	raw, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cfg, nil
	}
	if err != nil {
		return cfg, err
	}
	if len(raw) == 0 {
		return cfg, nil
	}

	if err := json.Unmarshal(raw, &cfg); err != nil {
		return cfg, err
	}

	if cfg.Addr == "" {
		cfg.Addr = ":8080"
	}
	if cfg.SessionCookieName == "" {
		cfg.SessionCookieName = "docker_reader_session"
	}
	if len(cfg.Users) == 0 {
		cfg.Users = Default().Users
	}

	return cfg, nil
}
