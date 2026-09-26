import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "@/lib/session-types";
import { aJobOutput } from "@/test/factories";
import { ChatMode, chatModelKey, parsePromptReply, type ChatModelInfo } from "./ChatMode";
import { ndjsonStream, renderApp, stubFetch, type FetchRoute } from "./test-utils";

const vision: ChatModelInfo = { provider: "ollama", id: "llava", label: "LLaVA", tags: ["vision"], vision: true };
const blind: ChatModelInfo = { provider: "ollama", id: "llama3.2", label: "Llama 3.2", tags: [], vision: false };
const MODELS = [vision, blind];

const noActiveRun: FetchRoute = { url: "/api/runs", reply: { run: null } };

type ChatProps = Partial<ComponentProps<typeof ChatMode>> & { initialMessages?: ChatMessage[] };

/** ChatMode with real message state, so onMessages updates render like in the app. */
function Chat({ initialMessages = [], ...overrides }: ChatProps) {
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  return (
    <ChatMode
      models={MODELS}
      ollamaUp
      model={chatModelKey(vision)}
      onModel={() => {}}
      onUseAsPrompt={() => {}}
      onOpenKeys={() => {}}
      messages={messages}
      onMessages={setMessages}
      sessionId="session-1"
      agent={false}
      onAgent={() => {}}
      onUseAsInput={() => {}}
      clientId="client-1"
      onUpload={async () => []}
      {...overrides}
    />
  );
}

const composer = () => screen.getByPlaceholderText(/ask anything/i);

async function pasteImage(name = "photo.png") {
  const file = new File(["png-bytes"], name, { type: "image/png" });
  fireEvent.paste(composer(), { clipboardData: { files: [file], getData: () => "" } });
  return file;
}

describe("ChatMode composer", () => {
  it("Enter sends the conversation and streams the reply into an assistant message", async () => {
    const { of } = stubFetch(noActiveRun, { method: "POST", url: "/api/chat", reply: () => new Response("Hi there!") });
    const user = userEvent.setup();
    renderApp(<Chat />);

    await user.type(composer(), "Hello model{Enter}");

    await screen.findByText("Hi there!");
    expect(screen.getByText("Hello model")).toBeInTheDocument();
    expect(composer()).toHaveValue("");
    const posts = of("POST", "/api/chat");
    expect(posts).toHaveLength(1);
    const body = posts[0].body as { provider: string; model: string; messages: { role: string; content: string }[] };
    expect(body.provider).toBe("ollama");
    expect(body.model).toBe("llava");
    expect(body.messages).toEqual([{ role: "user", content: "Hello model", images: undefined, files: undefined }]);
  });

  it("Shift+Enter inserts a newline without sending", async () => {
    const { of } = stubFetch(noActiveRun);
    const user = userEvent.setup();
    renderApp(<Chat />);

    await user.type(composer(), "line one{Shift>}{Enter}{/Shift}line two");

    expect(composer()).toHaveValue("line one\nline two");
    expect(of("POST", "/api/chat")).toHaveLength(0);
  });

  it("renders pasted attachments as chips that can be removed", async () => {
    stubFetch(noActiveRun);
    const onUpload = vi.fn(async (files: File[]) => files.map((f) => ({ ref: `input/${f.name}`, filename: f.name, subfolder: "input" })));
    const user = userEvent.setup();
    renderApp(<Chat onUpload={onUpload} />);

    await pasteImage("photo.png");

    const chip = await screen.findByAltText("photo.png");
    expect(chip).toBeInTheDocument();
    expect(onUpload).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Remove attachment" }));
    expect(screen.queryByAltText("photo.png")).not.toBeInTheDocument();
  });

  it("disables send when an image is attached to a non-vision model", async () => {
    stubFetch(noActiveRun);
    const onUpload = vi.fn(async (files: File[]) => files.map((f) => ({ ref: `input/${f.name}`, filename: f.name, subfolder: "input" })));
    renderApp(<Chat model={chatModelKey(blind)} onUpload={onUpload} />);

    await pasteImage();
    await screen.findByAltText("photo.png");

    expect(screen.getByText(/cannot see images/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send" })).toBeDisabled();
  });

  it("edit-and-resend replaces the user message and drops everything after it", async () => {
    const { of } = stubFetch(noActiveRun, { method: "POST", url: "/api/chat", reply: () => new Response("Better answer") });
    const user = userEvent.setup();
    renderApp(
      <Chat
        initialMessages={[
          { role: "user", text: "First question" },
          { role: "assistant", text: "First answer" },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /edit/i }));
    const editBox = screen.getByDisplayValue("First question");
    await user.clear(editBox);
    await user.type(editBox, "Second question{Enter}");

    await screen.findByText("Better answer");
    expect(screen.queryByText("First answer")).not.toBeInTheDocument();
    const body = of("POST", "/api/chat")[0].body as { messages: { role: string; content: string }[] };
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ role: "user", content: "Second question" });
  });
});

describe("ChatMode message actions", () => {
  it("hands off a structured reply as prompt and negative prompt", async () => {
    stubFetch(noActiveRun);
    const onUseAsPrompt = vi.fn();
    const user = userEvent.setup();
    renderApp(
      <Chat
        onUseAsPrompt={onUseAsPrompt}
        initialMessages={[
          { role: "user", text: "Write a prompt" },
          { role: "assistant", text: "Prompt: a red fox in snow\nNegative prompt: blur, artifacts" },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /use as image prompt/i }));

    expect(onUseAsPrompt).toHaveBeenCalledWith({ prompt: "a red fox in snow", negativePrompt: "blur, artifacts" });
  });

  it("hands off the reply together with the photo the user attached", async () => {
    stubFetch(noActiveRun);
    const onUseAsPrompt = vi.fn();
    const attachment = { ref: "input/ref.png", filename: "ref.png", subfolder: "input" };
    const user = userEvent.setup();
    renderApp(
      <Chat
        onUseAsPrompt={onUseAsPrompt}
        initialMessages={[
          { role: "user", text: "Describe this", images: [attachment] },
          { role: "assistant", text: "Prompt: a lighthouse at dusk" },
        ]}
      />,
    );

    await user.click(screen.getByRole("button", { name: /use with the photo as reference/i }));

    expect(onUseAsPrompt).toHaveBeenCalledWith({ prompt: "a lighthouse at dusk", images: [attachment] });
  });

  it("branching forks the history truncated after the chosen message", async () => {
    stubFetch(noActiveRun);
    const onBranch = vi.fn();
    const history: ChatMessage[] = [
      { role: "user", text: "Question one" },
      { role: "assistant", text: "Answer one" },
    ];
    const user = userEvent.setup();
    renderApp(<Chat onBranch={onBranch} initialMessages={history} />);

    // One branch button per message: [0] the user message, [1] the assistant reply.
    await user.click(screen.getAllByRole("button", { name: /branch from here/i })[1]);
    expect(onBranch).toHaveBeenCalledWith(history);

    await user.click(screen.getAllByRole("button", { name: /branch from here/i })[0]);
    expect(onBranch).toHaveBeenLastCalledWith(history.slice(0, 1));
  });

  it("parsePromptReply falls back to the whole text without the structure", () => {
    expect(parsePromptReply("just words")).toEqual({ prompt: "just words" });
    expect(parsePromptReply('Prompt: "quoted fox"')).toEqual({ prompt: "quoted fox", negativePrompt: undefined });
  });
});

describe("ChatMode agent streaming", () => {
  function agentSetup(extra: FetchRoute[] = []) {
    const stream = ndjsonStream();
    const api = stubFetch(noActiveRun, { method: "POST", url: "/api/agent", reply: () => stream.response }, ...extra);
    return { stream, ...api };
  }

  it("tool cards move running → done and expose the produced image", async () => {
    const { stream } = agentSetup();
    const onUseAsInput = vi.fn();
    const output = aJobOutput();
    const user = userEvent.setup();
    renderApp(<Chat agent onUseAsInput={onUseAsInput} />);

    await user.type(composer(), "make a cat{Enter}");
    stream.push({ type: "run", id: "run-9" });
    stream.push({ type: "tool", id: "t1", name: "generate_image", args: { prompt: "a cat" }, state: "running" });
    await screen.findByText("Generating image");
    expect(screen.getByText("a cat")).toBeInTheDocument();

    stream.push({ type: "tool", id: "t1", name: "generate_image", args: { prompt: "a cat" }, state: "done", images: [output] });
    await screen.findByText("Generated");

    stream.push({ type: "text", text: "Here you go" });
    stream.close();
    await screen.findByText("Here you go");

    await user.click(screen.getByRole("button", { name: /edit in image/i }));
    expect(onUseAsInput).toHaveBeenCalledWith(output);
  });

  it("a failed tool call shows its error note on the card", async () => {
    const { stream } = agentSetup();
    const user = userEvent.setup();
    renderApp(<Chat agent />);

    await user.type(composer(), "try it{Enter}");
    stream.push({ type: "tool", id: "t1", name: "generate_image", args: {}, state: "error", note: "ComfyUI is offline" });
    await screen.findByText("ComfyUI is offline");
    stream.close();
  });

  it("Stop posts to the running agent's stop endpoint", async () => {
    const { stream, of } = agentSetup([{ method: "POST", url: "/api/runs/run-9/stop", reply: { ok: true } }]);
    const user = userEvent.setup();
    renderApp(<Chat agent />);

    await user.type(composer(), "long task{Enter}");
    stream.push({ type: "run", id: "run-9" });
    stream.push({ type: "text", text: "Working on it" });
    await screen.findByText("Working on it");

    await user.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() => expect(of("POST", "/api/runs/run-9/stop")).toHaveLength(1));
    stream.close();
  });

  it("the approval card posts Allow to /api/code/approve and remembers the path", async () => {
    const { stream, of } = agentSetup([{ method: "POST", url: "/api/code/approve", reply: { ok: true } }]);
    const onApprovePath = vi.fn();
    const user = userEvent.setup();
    renderApp(<Chat agent onApprovePath={onApprovePath} />);

    await user.type(composer(), "read my file{Enter}");
    stream.push({ type: "approval", id: "appr-1", path: "/outside/secret.txt", tool: "read_file" });
    await screen.findByText("/outside/secret.txt");
    expect(screen.getByText(/access outside the workspace/i)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Allow" }));

    await waitFor(() => expect(of("POST", "/api/code/approve")).toHaveLength(1));
    expect(of("POST", "/api/code/approve")[0].body).toEqual({ id: "appr-1", allow: true });
    expect(onApprovePath).toHaveBeenCalledWith("/outside/secret.txt");
    expect(screen.queryByText("/outside/secret.txt")).not.toBeInTheDocument();
    stream.close();
  });
});
