package utils

import "os"

func FileExists(path string) (bool, error) {
	_, err := os.Stat(path)
	if err == nil {
		return true, nil
	}

	if os.IsNotExist(err) {
		return false, nil
	}
	return false, err
}

func CreateFolderIfNotExists(path string) error {
	exists, err := FileExists(path)
	if err != nil {
		return err
	}

	if exists {
		return nil
	}

	err = os.MkdirAll(path, os.ModePerm)
	if err != nil {
		return err
	}

	return nil
}
