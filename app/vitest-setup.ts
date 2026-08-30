import '@testing-library/svelte/vitest';
import '@testing-library/jest-dom';
import * as matchers from '@testing-library/jest-dom/matchers';
import { expect } from 'vitest';

expect.extend(matchers);

// jsdom implements no ResizeObserver, and Svelte 5 runs component effects during
// tests where Svelte 4 deferred them — so the chart and map components now reach
// their observer setup and threw `ResizeObserver is not defined`. A no-op stub is
// the right shape: these tests assert rendered output, not resize behaviour, and
// jsdom never fires a resize anyway.
class ResizeObserverStub implements ResizeObserver {
	observe(): void {}
	unobserve(): void {}
	disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub;
