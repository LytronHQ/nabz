module monitors/worker

go 1.22.5

replace monitors/corelib => ../corelib

require monitors/corelib v0.0.0-00010101000000-000000000000

require (
	github.com/joho/godotenv v1.5.1 // indirect
	github.com/valkey-io/valkey-go v1.0.43 // indirect
	golang.org/x/sys v0.19.0 // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
)
