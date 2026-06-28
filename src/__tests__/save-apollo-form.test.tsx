// @vitest-environment jsdom
/**
 * SaveApolloForm error-notification contract.
 *
 * In a Next.js production build, a Server Action that throws has its real
 * `Error.message` replaced by the framework's generic masking blurb before it
 * reaches the client `catch`. The form's failure notification must therefore
 * carry friendly, operation-specific copy — never the caught
 * `error.message` — or production users see the masking paragraph as the
 * toast body. (Host-side precedent: cinatra-ai/cinatra#51.)
 */
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const addNotification = vi.fn();

vi.mock("@cinatra-ai/sdk-ui", () => ({
  useNotify: () => ({ addNotification }),
}));

vi.mock("../actions", () => ({
  saveApolloConnectionAction: vi.fn(),
}));

import { SaveApolloForm } from "../save-apollo-form";
import { saveApolloConnectionAction } from "../actions";
import { Button } from "../components/ui/button";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// Shape of what the client receives from a rejected Server Action in a
// production build: an Error instance carrying the masking text instead of
// the original server-side message.
const PROD_MASKED_MESSAGE =
  "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details.";

const mountedRoots: Root[] = [];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => {
      root.unmount();
    });
  }
  document.body.innerHTML = "";
});

async function renderAndSubmit(): Promise<void> {
  const container = document.createElement("div");
  document.body.appendChild(container);

  const root = createRoot(container);
  mountedRoots.push(root);

  await act(async () => {
    root.render(
      <SaveApolloForm>
        <Button type="submit">Save</Button>
      </SaveApolloForm>,
    );
  });

  const form = container.querySelector("form");
  expect(form).not.toBeNull();

  await act(async () => {
    form!.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    // Let the submit handler's async rejection settle.
    await Promise.resolve();
  });
}

describe("SaveApolloForm server-action rejection", () => {
  it("shows the friendly operation-specific notification when the action rejects with a prod-masked Error", async () => {
    vi.mocked(saveApolloConnectionAction).mockRejectedValueOnce(
      new Error(PROD_MASKED_MESSAGE),
    );

    await renderAndSubmit();

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification).toHaveBeenCalledWith({
      title: "Apollo save failed",
      body: "Unable to save the Apollo connection.",
      kind: "error",
    });
    const { title, body } = addNotification.mock.calls[0][0] as {
      title: string;
      body: string;
    };
    expect(body).not.toContain("omitted in production");
    expect(body).not.toContain(PROD_MASKED_MESSAGE);
    // The title identifies the failed operation (not a bare "Save failed").
    expect(title).not.toBe("Save failed");
  });

  it("shows the success notification when the action resolves", async () => {
    vi.mocked(saveApolloConnectionAction).mockResolvedValueOnce(undefined);

    await renderAndSubmit();

    expect(addNotification).toHaveBeenCalledTimes(1);
    expect(addNotification).toHaveBeenCalledWith({
      title: "Apollo connection saved",
      body: "Your Apollo API key has been validated and stored.",
      kind: "success",
    });
  });
});
