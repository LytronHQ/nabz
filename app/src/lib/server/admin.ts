// People-level admin gate for the private /admin pages.
//
// A user is an admin iff their email is in the ADMIN_EMAILS allowlist (comma- or
// whitespace-separated, case-insensitive). An empty/unset allowlist means NOBODY
// is an admin (fail closed). This is deliberately separate from
// HEALTH_DEBUG_TOKEN (#103): that token gates scrubbed liveness detail for
// machines; this gates private business data for people — different mechanism,
// different secret, no sharing.
//
// Pure (allowlist passed in) so it's unit-testable; callers pass env.ADMIN_EMAILS.

// isAdminUser is the gate to use: the email must also be verified. Signup
// accepts any address and verification is only requested, so an allowlisted
// address nobody had registered yet was an admin to whoever signed up with it
// first (#671).
export function isAdminUser(
	user: Record<string, unknown> | null | undefined,
	adminEmailsCsv: string | undefined
): boolean {
	return (
		user?.verified === true && typeof user.email === 'string' && isAdmin(user.email, adminEmailsCsv)
	);
}

export function isAdmin(
	email: string | null | undefined,
	adminEmailsCsv: string | undefined
): boolean {
	if (!email) return false;
	const allow = (adminEmailsCsv ?? '')
		.split(/[,\s]+/)
		.map((e) => e.trim().toLowerCase())
		.filter(Boolean);
	return allow.includes(email.trim().toLowerCase());
}
