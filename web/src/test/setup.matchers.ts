import { expect } from "vitest";
import { safelightMatchers } from "./matchers";

// Wired into every vitest project via setupFiles (vitest.config.ts).
expect.extend(safelightMatchers);
