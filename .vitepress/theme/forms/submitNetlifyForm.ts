// Netlify Forms accepts a runtime submission the same way it would a native
// HTML form post: a same-origin request with a url-encoded body carrying
// every field plus the special "form-name" key, which ties the request back
// to the <form data-netlify="true"> that Netlify's build-time bot parsed out
// of the static HTML at deploy time. Isolated here (rather than inlined in
// ContactForm.vue) so the network call is swappable/mockable in tests,
// matching how loadGoogleAnalytics.ts isolates the one place this codebase
// talks to an external service.
const FORM_URLENCODED_CONTENT_TYPE = "application/x-www-form-urlencoded";
const NETLIFY_FORMS_SUBMIT_PATH = "/";
const FORM_NAME_FIELD = "form-name";
// Without a deadline a stalled connection (e.g. a captive portal) leaves the
// form stuck in "submitting" with no retry path. AbortSignal.timeout needs
// Chrome 103 / Safari 16 / Firefox 100 (2022), an accepted browser floor.
export const SUBMIT_TIMEOUT_MS = 15_000;

export interface NetlifyFormSubmission {
  formName: string;
  fields: Record<string, string>;
}

// The narrow slice of the `fetch` contract this module needs, so a test can
// inject an in-memory fake instead of mocking the real global. The init type
// is derived from `typeof fetch` (rather than the bare `RequestInit` name)
// because `RequestInit` is a lib.dom.d.ts *type*, not a runtime global, and
// this repo's ESLint config runs the base (non-type-aware) `no-undef` rule,
// which can't tell a type position from a value reference and flags it as an
// undefined global — see the identical note on `FetchInit` in
// netlify/functions/lib/githubFailureNotifier.ts. Parameter names are
// prefixed `_` (matching BlobWriter in cspReportStore.ts) since they exist
// only to document the shape, and the same base `no-unused-vars` rule would
// otherwise flag them as unused bindings.
export type FetchLike = (
  _input: string,
  _init: NonNullable<Parameters<typeof fetch>[1]>,
) => Promise<Pick<Response, "ok" | "status">>;

// Aborts after timeoutMs (rejecting with a TimeoutError). Throws on a non-2xx
// response rather than swallowing it, so the caller
// (ContactForm.vue) can surface a real failure to the visitor instead of
// silently reporting success for a submission Netlify never recorded.
export async function submitNetlifyForm(
  submission: NetlifyFormSubmission,
  fetchImpl: FetchLike = fetch,
  timeoutMs: number = SUBMIT_TIMEOUT_MS,
): Promise<void> {
  // Reserved key spread last so it always wins: a caller-supplied field
  // literally named "form-name" (unlikely, but this takes untrusted visitor
  // input) must never override the value that ties the submission back to
  // the registered form.
  const body = new URLSearchParams({
    ...submission.fields,
    [FORM_NAME_FIELD]: submission.formName,
  });
  const response = await fetchImpl(NETLIFY_FORMS_SUBMIT_PATH, {
    method: "POST",
    headers: { "Content-Type": FORM_URLENCODED_CONTENT_TYPE },
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    throw new Error(`Netlify Forms submission failed: ${response.status}`);
  }
}
