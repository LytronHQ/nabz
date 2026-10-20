// jest-dom's own vitest typings (7.0.1) extend `Assertion<T>`, which vitest 5
// replaced with `Assertion<R, T>`, so every toBeInTheDocument() stopped
// type-checking. `Matchers` is the interface vitest documents for custom
// matchers, and it carries the return type jest-dom needs.
import type { TestingLibraryMatchers } from '@testing-library/jest-dom/matchers';

declare module 'vitest' {
	// A merge must repeat vitest's type parameters exactly (so T stays, unused), and
	// an interface that only extends is how a merge adds members: both rules are
	// wrong about this line.
	// eslint-disable-next-line @typescript-eslint/no-empty-object-type
	interface Matchers<
		R extends void | Promise<void> = void | Promise<void>,
		// eslint-disable-next-line @typescript-eslint/no-unused-vars
		T = unknown
	> extends TestingLibraryMatchers<unknown, R> {}
}

export {};
