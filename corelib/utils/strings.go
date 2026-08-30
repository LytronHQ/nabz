package utils

import (
	"regexp"
)

func IsValidPocketBaseId(id string) bool {
	var re = regexp.MustCompile(`^[a-zA-Z0-9]+$`)
	return re.MatchString(id)
}
