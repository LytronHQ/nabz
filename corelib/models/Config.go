package models

type Config struct {
	Api *struct {
		Host string `yaml:"host"`
		Port string `yaml:"port"`
	} `yaml:"api"`
	PB *struct {
		URL   string `yaml:"url"`
		Admin struct {
			// Collection is the auth collection to authenticate against. It must
			// be set to a scoped service-account collection (e.g.
			// "service_accounts"); an empty value is rejected rather than
			// falling back to "_superusers", so the apps never run with
			// superuser rights by accident (#70).
			Collection string `yaml:"collection"`
			Username   string `yaml:"username"`
			Password   string `yaml:"password"`
			Token      string `yaml:"token"`
		} `yaml:"admin"`
	} `yaml:"pb"`
	Cache *struct {
		Host string `yaml:"host"`
		Port int    `yaml:"port"`
		// Password authenticates against a SHARED zone Valkey (#311). Empty for
		// the per-node sidecar, which is only reachable inside the compose
		// network. A shared instance is reached over a private/tailnet interface
		// and must set it.
		Password string `yaml:"password"`
	} `yaml:"cache"`
	Region *struct {
		Name string `yaml:"name"`
	} `yaml:"region"`
	// Worker is this process's OPS identity — logs, health, heartbeat — and is
	// deliberately NOT the zone (#311). The zone is a shard key written to
	// checks.zone and used for due:<zone>; the worker id never reaches a check
	// row. Defaults to the hostname, which is unique per container.
	Worker *struct {
		Id string `yaml:"id"`
	} `yaml:"worker"`
	AppDirectory string
	HostName     string
}
