package models

type Config struct {
	Api *struct {
		Host string `yaml:"host"`
		Port string `yaml:"port"`
	} `yaml:"api"`
	PB *struct {
		URL string `yaml:"url"`
		// Access is a Cloudflare Access service token, for a node that reaches
		// PocketBase through the public tunnel instead of the private network.
		// Empty on the nodes that sit inside the private network.
		Access struct {
			ClientId     string `yaml:"client_id"`
			ClientSecret string `yaml:"client_secret"`
		} `yaml:"access"`
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
	Region *struct {
		Name string `yaml:"name"`
	} `yaml:"region"`
	// Worker is this process's OPS identity — logs, health, zone_stats.worker —
	// and is deliberately NOT the zone. The zone is the shard key written to
	// checks.zone; the worker id never reaches a check row. Defaults to the
	// hostname, which is unique per container.
	Worker *struct {
		Id string `yaml:"id"`
		// Concurrency is how many checks the worker runs at once. 0 (an unset
		// WORKER_CONCURRENCY) means the built-in default.
		Concurrency int `yaml:"concurrency"`
	} `yaml:"worker"`
	AppDirectory string
	HostName     string
}
