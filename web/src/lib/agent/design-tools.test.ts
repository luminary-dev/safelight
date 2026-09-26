import { describe, expect, it } from "vitest";
import { guardUrl } from "./design-tools";

const BLOCKED = [
  "http://localhost/x",
  "http://localhost:3001/api/keys",
  "https://127.0.0.1/",
  "http://127.1.2.3/",
  "http://0.0.0.0/",
  "http://10.0.0.5/",
  "http://192.168.1.1/admin",
  "http://172.16.0.1/",
  "http://172.31.255.255/",
  "http://169.254.169.254/latest/meta-data/",
  "http://foo.local/",
  "http://backend.internal/",
  "ftp://example.com/file",
  "file:///etc/passwd",
];

const ALLOWED = ["https://example.com/", "http://example.org/page?q=1", "https://sub.domain.co.uk/path"];

describe("guardUrl", () => {
  it.each(BLOCKED)("blocks %s", (url) => {
    expect(() => guardUrl(url)).toThrow();
  });

  it.each(ALLOWED)("allows %s", (url) => {
    expect(guardUrl(url).href).toContain("://");
  });

  it("rejects garbage", () => {
    expect(() => guardUrl("not a url")).toThrow(/not a valid URL/);
  });

  it("does not block public 172.x outside the private range", () => {
    expect(() => guardUrl("http://172.32.0.1/")).not.toThrow();
  });
});
