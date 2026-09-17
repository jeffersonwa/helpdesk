// Global test setup for the Vitest suite.
//
// This file runs once before the test files in each worker. Keep it minimal:
// register only cross-cutting configuration that every test relies on.
//
// A deterministic default environment keeps engine/unit tests reproducible.
process.env.TZ = process.env.TZ ?? "UTC";
process.env.NODE_ENV = process.env.NODE_ENV ?? "test";
