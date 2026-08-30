package utils

import (
	"log"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"monitors/corelib/models"

	"github.com/joho/godotenv"
	"gopkg.in/yaml.v2"
)

func LoadConfig() (config models.Config) {
	if err := godotenv.Load(); err != nil {
		log.Println("No .env file found")
	}

	appExectutablePath, getAppExecPathError := os.Executable()
	if getAppExecPathError != nil {
		log.Fatalf("Error getting executable path of the app, error: %s", getAppExecPathError)
	}

	appDirectory := filepath.Dir(appExectutablePath)
	config = readConfig(appDirectory)

	config.AppDirectory = appDirectory

	hostName, getHostNameError := os.Hostname()
	if getHostNameError != nil {
		log.Fatalf("Error getting host name, error: %s", getHostNameError)
	}

	config.HostName = hostName

	return config
}

func readConfig(directory string) (config models.Config) {
	fileContentBytes, readFileError := os.ReadFile(filepath.Join(directory, "config.yml"))
	if readFileError != nil {
		log.Fatalf("Error reading config.yml file, error: %s", readFileError)
	}

	fileContents := string(fileContentBytes)
	regexEnvVars := regexp.MustCompile(`(?i)(\<ENV:([a-zA-Z0-9_]+)\>)`)
	regexEnvVarsMatches := regexEnvVars.FindAllStringSubmatch(fileContents, -1)
	for _, regexEnvVarsGroups := range regexEnvVarsMatches {
		if len(regexEnvVarsGroups) < 3 {
			log.Fatalf(`error finding environment variables in config YAML file,
			expected regex groups: 3, actual regex groups: %d, values: %s`, len(regexEnvVarsGroups), regexEnvVarsGroups)
		}

		fileContents = strings.ReplaceAll(fileContents, regexEnvVarsGroups[1], os.Getenv(regexEnvVarsGroups[2]))
	}

	fileContentsReader := strings.NewReader(fileContents)
	fileContentsDecoder := yaml.NewDecoder(fileContentsReader)
	decodeError := fileContentsDecoder.Decode(&config)

	if decodeError != nil {
		log.Fatalf("Error decoding config.yml file, error: %s", decodeError)
	}

	return config
}
