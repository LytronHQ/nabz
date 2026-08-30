package utils

import (
	"log"
	"time"
)

func TimerPrint(name string) func() {
	start := time.Now().UTC()
	return func() {
		log.Printf("Finished [%s], took %v\n", name, time.Since(start).Round(time.Millisecond))
	}
}

func TimerGet() func() time.Duration {
	start := time.Now().UTC()
	return func() time.Duration {
		return time.Since(start).Round(time.Millisecond)
	}
}
