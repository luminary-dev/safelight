import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { chatModelKey } from "./ChatMode";
import { ModelPicker, type PickerOption } from "./ModelPicker";
import { renderApp, stubFetch } from "./test-utils";

const local: PickerOption = { key: "local:qwen", label: "Qwen Image", tags: ["Q4_K_M"], provider: "local" };
const ollama: PickerOption = { key: chatModelKey({ provider: "ollama", id: "llama3.2" }), label: "Llama 3.2", provider: "ollama" };
const cloud: PickerOption = { key: "cloud:gpt-image-1", label: "GPT Image 1", provider: "openai", hint: "text + image edits" };

describe("ModelPicker", () => {
  it("the closed trigger is a named combobox showing the selection and its tags", () => {
    stubFetch();
    renderApp(<ModelPicker options={[local, cloud]} value={local.key} onChange={() => {}} />);

    const trigger = screen.getByRole("combobox", { name: "Choose a model" });
    expect(within(trigger).getByText("Qwen Image")).toBeInTheDocument();
    expect(within(trigger).getByText("Local · Q4_K_M")).toBeInTheDocument();
  });

  it("groups options by provider, marks the selection, and reports a choice", async () => {
    stubFetch();
    const onChange = vi.fn();
    const user = userEvent.setup();
    renderApp(<ModelPicker options={[local, ollama, cloud]} value={local.key} onChange={onChange} />);

    await user.click(screen.getByRole("combobox", { name: "Choose a model" }));
    expect(await screen.findByRole("group", { name: "On this Mac" })).toBeInTheDocument(); // local + ollama share a group
    expect(screen.getByRole("group", { name: "OpenAI" })).toBeInTheDocument();

    await user.click(screen.getByText("GPT Image 1"));
    expect(onChange).toHaveBeenCalledWith(cloud.key);
    expect(screen.queryByText("On this Mac")).not.toBeInTheDocument(); // picking closes the popover
  });

  it("search narrows the list and a miss says so", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderApp(<ModelPicker options={[local, ollama]} value={null} onChange={() => {}} />);

    await user.click(screen.getByRole("combobox", { name: "Choose a model" }));
    await user.type(await screen.findByPlaceholderText("Search models"), "llama");
    expect(screen.getByText("Llama 3.2")).toBeInTheDocument();
    expect(screen.queryByText("Qwen Image")).not.toBeInTheDocument();

    await user.clear(screen.getByPlaceholderText("Search models"));
    await user.type(screen.getByPlaceholderText("Search models"), "zzz");
    expect(screen.getByText("Nothing matches.")).toBeInTheDocument();
  });

  it("with no models at all it shows the empty hint and offers to add a key", async () => {
    stubFetch();
    const onAddKey = vi.fn();
    const user = userEvent.setup();
    renderApp(<ModelPicker options={[]} value={null} onChange={() => {}} onAddKey={onAddKey} emptyHint="Ollama is offline." />);

    await user.click(screen.getByRole("combobox", { name: "Choose a model" }));
    expect(await screen.findByText("Ollama is offline.")).toBeInTheDocument();

    await user.click(screen.getByText("Add a cloud provider"));
    expect(onAddKey).toHaveBeenCalledTimes(1);
  });
});
