import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { KeysDialog, type KeyStatus } from "./KeysDialog";
import { renderApp, stubFetch, type FetchRoute } from "./test-utils";

const openaiKey: KeyStatus = { provider: "openai", label: "OpenAI", configured: true, hint: "…f3ab", source: "vault", chat: true, images: true, kind: "model" as const };
const envKey: KeyStatus = { provider: "anthropic", label: "Anthropic", configured: true, source: "env", chat: true, images: false, kind: "model" as const };
const unsetKey: KeyStatus = { provider: "gemini", label: "Gemini", configured: false, chat: true, images: true, kind: "model" as const };

const keysRoute = (keys: KeyStatus[]): FetchRoute => ({ url: "/api/keys", reply: { keys } });

describe("KeysDialog", () => {
  it("shows only the key hint, and typed keys stay masked until Show is pressed", async () => {
    stubFetch(keysRoute([openaiKey, unsetKey]));
    const user = userEvent.setup();
    renderApp(<KeysDialog open onClose={() => {}} onChanged={() => {}} />);

    // The configured provider reveals nothing beyond the vault hint.
    await screen.findByText("key …f3ab");
    expect(document.body.textContent).not.toMatch(/sk-[a-z0-9]{8,}/i);

    const input = screen.getByPlaceholderText("Paste a new key to replace");
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, "sk-live-supersecret");
    expect(input).toHaveAttribute("type", "password"); // still masked while typing

    await user.click(screen.getAllByRole("button", { name: "Show key" })[0]);
    expect(input).toHaveAttribute("type", "text");
    await user.click(screen.getAllByRole("button", { name: "Hide key" })[0]);
    expect(input).toHaveAttribute("type", "password");
  });

  it("the reveal toggle sits beside the input, never over it, and long values truncate with titles", async () => {
    const proxied: KeyStatus = { ...openaiKey, baseUrl: "https://my-very-long-proxy.example.com/v1/openai/custom-endpoint" };
    stubFetch(keysRoute([proxied]));
    renderApp(<KeysDialog open onClose={() => {}} onChanged={() => {}} />);
    await screen.findByText("key …f3ab");

    // §4 overlaps: the eye toggle is a flex sibling of the input inside the
    // field group — not absolutely positioned over the input's rect.
    const eye = screen.getByRole("button", { name: "Show key" });
    const input = screen.getByPlaceholderText("Paste a new key to replace");
    expect(eye.className).not.toContain("absolute");
    expect(eye.parentElement).toBe(input.parentElement);

    // Truncating values keep their full text reachable (title), and nothing reveals the key itself.
    expect(screen.getByTitle("key …f3ab")).toBeInTheDocument();
    expect(screen.getByTitle(/my-very-long-proxy\.example\.com/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/sk-[a-z0-9]{8,}/i);
  });

  it("labels the key's source: env keys are not removable, vault keys are", async () => {
    stubFetch(keysRoute([openaiKey, envKey]));
    renderApp(<KeysDialog open onClose={() => {}} onChanged={() => {}} />);

    await screen.findByText("from environment");
    // Exactly one remove button: the vault key's, never the env key's.
    expect(screen.getAllByTitle("Remove key")).toHaveLength(1);
  });

  it("saving posts the key and shows the validation verdict", async () => {
    const { of } = stubFetch(keysRoute([unsetKey]), {
      method: "POST",
      url: "/api/keys",
      reply: { keys: [{ ...unsetKey, configured: true, hint: "…12cd", source: "vault" }], validation: { ok: false, message: "That key was rejected (401)." } },
    });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderApp(<KeysDialog open onClose={() => {}} onChanged={onChanged} />);

    await user.type(await screen.findByPlaceholderText("AIza…"), "AIza-new-key");
    await user.click(screen.getByRole("button", { name: /save/i }));

    await screen.findByText("That key was rejected (401).");
    expect(of("POST", "/api/keys")[0].body).toEqual({ provider: "gemini", key: "AIza-new-key" });
    expect(onChanged).toHaveBeenCalled();
    expect(screen.getByText("key …12cd")).toBeInTheDocument();
  });

  it("removing a vault key posts key: null", async () => {
    const { of } = stubFetch(keysRoute([openaiKey]), { method: "POST", url: "/api/keys", reply: { keys: [{ ...openaiKey, configured: false, hint: undefined, source: undefined }] } });
    const user = userEvent.setup();
    renderApp(<KeysDialog open onClose={() => {}} onChanged={() => {}} />);

    await user.click(await screen.findByTitle("Remove key"));

    await waitFor(() => expect(of("POST", "/api/keys")).toHaveLength(1));
    expect(of("POST", "/api/keys")[0].body).toEqual({ provider: "openai", key: null });
  });

  it("Escape closes the dialog", async () => {
    stubFetch(keysRoute([unsetKey]));
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderApp(<KeysDialog open onClose={onClose} onChanged={() => {}} />);
    await screen.findByRole("dialog", { name: "API keys" });

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });
});
