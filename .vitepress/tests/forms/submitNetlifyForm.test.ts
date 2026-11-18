import { describe, it, expect, vi } from "vitest";
import {
  SUBMIT_TIMEOUT_MS,
  submitNetlifyForm,
  type FetchLike,
} from "@theme/forms/submitNetlifyForm";

// The narrow shape submitNetlifyForm needs from a Response, matching FetchLike's
// own return type — a fake, not the real global, since the module isolates its
// one external touchpoint precisely so tests never need a real network call.
function fakeFetch(response: { ok: boolean; status: number }): FetchLike {
  return vi.fn().mockResolvedValue(response) as unknown as FetchLike;
}

describe("submitNetlifyForm", () => {
  it("POSTs a url-encoded body carrying form-name plus every field", async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200 });
    await submitNetlifyForm(
      {
        formName: "contact",
        fields: { name: "Ada", email: "ada@example.com" },
      },
      fetchImpl,
    );

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("/");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Content-Type": "application/x-www-form-urlencoded",
    });

    const body = new URLSearchParams(init.body as string);
    expect(body.get("form-name")).toBe("contact");
    expect(body.get("name")).toBe("Ada");
    expect(body.get("email")).toBe("ada@example.com");
  });

  it("resolves without throwing on a 2xx response", async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200 });
    await expect(
      submitNetlifyForm({ formName: "contact", fields: {} }, fetchImpl),
    ).resolves.toBeUndefined();
  });

  it("throws when the response is not ok, naming the status", async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 500 });
    await expect(
      submitNetlifyForm({ formName: "contact", fields: {} }, fetchImpl),
    ).rejects.toThrow("500");
  });

  it("never lets a field literally named form-name override the real form name", async () => {
    const fetchImpl = fakeFetch({ ok: true, status: 200 });
    await submitNetlifyForm(
      { formName: "contact", fields: { "form-name": "evil" } },
      fetchImpl,
    );
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = new URLSearchParams(init.body as string);
    expect(body.get("form-name")).toBe("contact");
  });

  it("propagates a network failure instead of swallowing it", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as FetchLike;
    await expect(
      submitNetlifyForm({ formName: "contact", fields: {} }, fetchImpl),
    ).rejects.toThrow("network down");
  });

  it("rejects with a TimeoutError when fetch never settles before the deadline", async () => {
    const hangingFetch: FetchLike = (_input, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          reject(init.signal?.reason);
        });
      });
    await expect(
      submitNetlifyForm({ formName: "contact", fields: {} }, hangingFetch, 10),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });

  it("passes an abort signal using the 15 second default deadline", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    const fetchImpl = fakeFetch({ ok: true, status: 200 });
    await submitNetlifyForm({ formName: "contact", fields: {} }, fetchImpl);

    expect(SUBMIT_TIMEOUT_MS).toBe(15_000);
    expect(timeoutSpy).toHaveBeenCalledWith(SUBMIT_TIMEOUT_MS);
    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
    timeoutSpy.mockRestore();
  });
});
