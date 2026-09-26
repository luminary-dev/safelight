import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { ThemeToggle } from "./ThemeToggle";
import { renderApp, stubFetch } from "./test-utils";

afterEach(() => {
  document.documentElement.classList.remove("dark");
  window.history.replaceState(null, "", "/");
});

describe("ThemeToggle", () => {
  it("defaults to light and toggles to dark: class, label, and saved preference", async () => {
    stubFetch();
    const user = userEvent.setup();
    renderApp(<ThemeToggle />);

    const button = screen.getByRole("button", { name: "Switch to dark theme" });
    expect(document.documentElement).not.toHaveClass("dark");

    await user.click(button);
    expect(document.documentElement).toHaveClass("dark");
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
    expect(localStorage.getItem("safelight.theme")).toBe("dark");

    await user.click(screen.getByRole("button", { name: "Switch to light theme" }));
    expect(document.documentElement).not.toHaveClass("dark");
    expect(localStorage.getItem("safelight.theme")).toBe("light");
  });

  it("starts from the saved preference", () => {
    stubFetch();
    localStorage.setItem("safelight.theme", "dark");
    renderApp(<ThemeToggle />);
    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
  });

  it("?theme= in the URL wins over the saved preference without persisting", () => {
    stubFetch();
    localStorage.setItem("safelight.theme", "light");
    window.history.replaceState(null, "", "/?theme=dark");
    renderApp(<ThemeToggle />);

    expect(screen.getByRole("button", { name: "Switch to light theme" })).toBeInTheDocument();
    expect(localStorage.getItem("safelight.theme")).toBe("light"); // only a click persists
  });
});
