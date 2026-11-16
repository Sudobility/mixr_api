import { test, expect, describe } from "vitest";
import { successResponse, errorResponse } from "@sudobility/types";

describe("health check", () => {
  test("API response format is consistent", () => {
    // Verify the canonical envelope shape used across all endpoints.
    const success = successResponse([]);
    const error = errorResponse("Something went wrong");

    expect(success).toHaveProperty("success", true);
    expect(success).toHaveProperty("data");
    expect(typeof success.timestamp).toBe("string");

    expect(error).toHaveProperty("success", false);
    expect(error).toHaveProperty("error", "Something went wrong");
    expect(typeof error.timestamp).toBe("string");
  });
});
