module monitors/evaluator

go 1.25.0

replace monitors/corelib => ../corelib

require (
	github.com/SherClockHolmes/webpush-go v1.4.0
	golang.org/x/crypto v0.52.0
	monitors/corelib v0.0.0-00010101000000-000000000000
)

require (
	github.com/golang-jwt/jwt/v5 v5.2.1 // indirect
	github.com/joho/godotenv v1.5.1 // indirect
	golang.org/x/net v0.54.0 // indirect
	gopkg.in/yaml.v2 v2.4.0 // indirect
)
