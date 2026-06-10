"use client";

// Relocated from `@cinatra-ai/connectors/save-forms` into the connector itself
// (SDK-only decouple). Imports the relocated server action from the
// connector's own `./actions` and surfaces results via the SDK's `useNotify`.

import { useNotify } from "@cinatra-ai/sdk-ui";
import { saveApolloConnectionAction } from "./actions";

export function SaveApolloForm({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const { addNotification } = useNotify();

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    // The "Clear saved key" button inside this form has formAction={clearApolloConnectionAction}.
    // When that button is clicked, the submit event fires with a submitter that has a formaction
    // attribute. We must not intercept that — let React/Next.js handle the server action button
    // natively. Only intercept the default submit (the "Save API connection" button).
    const submitter = (e.nativeEvent as SubmitEvent).submitter as HTMLButtonElement | null;
    if (submitter?.hasAttribute("formaction")) {
      return;
    }

    e.preventDefault();
    const formData = new FormData(e.currentTarget);

    try {
      await saveApolloConnectionAction(formData);
      addNotification({
        title: "Apollo connection saved",
        body: "Your Apollo API key has been validated and stored.",
        kind: "success",
      });
    } catch {
      // Never surface the caught error's message: in a Next.js production
      // build a thrown Server Action error reaches this catch with its real
      // message replaced by the framework's generic masking blurb, so piping
      // `error.message` into the toast would render that blurb instead of
      // useful copy. The friendly operation-specific body is unconditional;
      // the real failure detail stays in server-side logs.
      addNotification({
        title: "Apollo save failed",
        body: "Unable to save the Apollo connection.",
        kind: "error",
      });
    }
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      {children}
    </form>
  );
}
