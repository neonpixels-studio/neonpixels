import { describe, it, expect, vi, afterEach } from "vitest";
import { mount, flushPromises } from "@vue/test-utils";
import ContactForm from "@components/ContactForm.vue";

// Isolates the network call so these tests assert on component behavior
// (state transitions, what gets submitted) without a real fetch, mirroring
// how submitNetlifyForm.test.ts tests the network call on its own.
vi.mock("@theme/forms/submitNetlifyForm", () => ({
  submitNetlifyForm: vi.fn(),
}));

import { submitNetlifyForm } from "@theme/forms/submitNetlifyForm";

const mockedSubmitNetlifyForm = vi.mocked(submitNetlifyForm);

async function fillFields(
  wrapper: ReturnType<typeof mount>,
  values: { name?: string; email?: string; message?: string },
) {
  for (const [fieldName, fieldValue] of Object.entries(values)) {
    if (fieldValue === undefined) {
      continue;
    }
    await wrapper.find(`#contact-${fieldName}`).setValue(fieldValue);
  }
}

async function fillAndSubmit(
  wrapper: ReturnType<typeof mount>,
  values: { name?: string; email?: string; message?: string },
) {
  await fillFields(wrapper, values);
  await wrapper.find("form").trigger("submit");
  // The mocked submitNetlifyForm resolves/rejects on a microtask; flushPromises
  // drains that queue before the assertions look at status-driven DOM, rather
  // than relying on a single $nextTick to happen to cover both the awaited
  // mock and handleSubmit's own continuation.
  await flushPromises();
}

describe("ContactForm", () => {
  afterEach(() => {
    mockedSubmitNetlifyForm.mockReset();
  });

  it("ships the static markup Netlify's build-time bot needs to register the form", () => {
    const wrapper = mount(ContactForm);
    const form = wrapper.get("form");
    expect(form.attributes("name")).toBe("contact");
    expect(form.attributes("data-netlify")).toBe("true");
    expect(form.attributes("data-netlify-honeypot")).toBe("bot-field");
    expect(form.attributes("method")).toBe("POST");

    const formNameInput = wrapper.get('input[name="form-name"]');
    expect(formNameInput.attributes("type")).toBe("hidden");
    expect(formNameInput.attributes("value")).toBe("contact");
    wrapper.unmount();
  });

  it("hides the honeypot field from sighted users, assistive tech, and the tab order", () => {
    const wrapper = mount(ContactForm);
    const honeypotField = wrapper.get('input[name="bot-field"]');
    const honeypotWrapper = honeypotField.element.closest("p");
    expect(honeypotWrapper).not.toBeNull();
    expect(honeypotWrapper?.getAttribute("aria-hidden")).toBe("true");
    expect(honeypotWrapper?.classList.contains("hidden")).toBe(true);
    expect(honeypotField.attributes("tabindex")).toBe("-1");
    wrapper.unmount();
  });

  it("labels every visible field with an explicit, nested association", () => {
    const wrapper = mount(ContactForm);
    ["contact-name", "contact-email", "contact-message"].forEach((id) => {
      const control = wrapper.get(`#${id}`);
      const label = wrapper.get(`label[for="${id}"]`);
      expect(label.element.contains(control.element)).toBe(true);
    });
    wrapper.unmount();
  });

  it("keeps the status and alert live regions mounted at rest, with no text", () => {
    // Both regions must exist from the start (not be v-if'd in later), or a
    // screen reader can miss the announcement that arrives the same instant
    // the region itself is inserted.
    const wrapper = mount(ContactForm);
    expect(wrapper.get('[role="status"]').text()).toBe("");
    expect(wrapper.get('[role="alert"]').text()).toBe("");
    wrapper.unmount();
  });

  it("disables the submit button and shows a sending label while in flight", async () => {
    let resolveSubmit: () => void = () => {};
    mockedSubmitNetlifyForm.mockReturnValue(
      new Promise((resolve) => {
        resolveSubmit = () => resolve(undefined);
      }),
    );
    const wrapper = mount(ContactForm);
    await fillFields(wrapper, {
      name: "Ada",
      email: "ada@example.com",
      message: "hello",
    });
    await wrapper.find("form").trigger("submit");

    const button = wrapper.get("button");
    expect(button.attributes("disabled")).toBeDefined();
    expect(button.text()).toContain("sending");

    resolveSubmit();
    await flushPromises();
    expect(wrapper.get("button").attributes("disabled")).toBeUndefined();
    wrapper.unmount();
  });

  it("ignores a second submit event fired while the first is still in flight", async () => {
    // Regression guard for pressing Enter in a text field: that re-fires the
    // form's submit event directly, bypassing the disabled submit button, so
    // the guard against a duplicate request has to live in handleSubmit
    // itself, not just on the button.
    mockedSubmitNetlifyForm.mockReturnValue(new Promise(() => {}));
    const wrapper = mount(ContactForm);
    await fillFields(wrapper, {
      name: "Ada",
      email: "ada@example.com",
      message: "hello",
    });
    await wrapper.find("form").trigger("submit");
    await wrapper.find("form").trigger("submit");

    expect(mockedSubmitNetlifyForm).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("has an accessible heading naming the section", () => {
    const wrapper = mount(ContactForm);
    const heading = wrapper.get("h2");
    expect(heading.text()).toContain("get in touch");
    wrapper.unmount();
  });

  it("submits the entered fields and shows a success message", async () => {
    mockedSubmitNetlifyForm.mockResolvedValue(undefined);
    const wrapper = mount(ContactForm);

    await fillAndSubmit(wrapper, {
      name: "Ada",
      email: "ada@example.com",
      message: "hello",
    });

    expect(mockedSubmitNetlifyForm).toHaveBeenCalledWith({
      formName: "contact",
      fields: { name: "Ada", email: "ada@example.com", message: "hello" },
    });
    expect(wrapper.get('[role="status"]').text()).not.toBe("");
    expect(wrapper.get('[role="alert"]').text()).toBe("");
    // Resets the visible fields so a second, separate message can't be
    // mistaken for a resubmission of the first.
    expect(wrapper.get<HTMLInputElement>("#contact-name").element.value).toBe(
      "",
    );
    wrapper.unmount();
  });

  it("shows an error message and keeps the entered fields on failure", async () => {
    mockedSubmitNetlifyForm.mockRejectedValue(new Error("network down"));
    const wrapper = mount(ContactForm);

    await fillAndSubmit(wrapper, {
      name: "Ada",
      email: "ada@example.com",
      message: "hello",
    });

    expect(wrapper.get('[role="alert"]').text()).not.toBe("");
    expect(wrapper.get('[role="status"]').text()).toBe("");
    // A failed send must not discard what the visitor already typed — losing
    // it on error would be worse than the failure itself.
    expect(wrapper.get<HTMLInputElement>("#contact-name").element.value).toBe(
      "Ada",
    );
    expect(
      wrapper.get<HTMLTextAreaElement>("#contact-message").element.value,
    ).toBe("hello");
    wrapper.unmount();
  });

  it("never calls the real submission when the honeypot is filled, but still reports success and resets the fields", async () => {
    const wrapper = mount(ContactForm);
    await fillFields(wrapper, { name: "Ada", email: "ada@example.com" });
    await wrapper.find("#contact-honeypot").setValue("spam bot filled this");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(mockedSubmitNetlifyForm).not.toHaveBeenCalled();
    expect(wrapper.get('[role="status"]').text()).not.toBe("");
    expect(wrapper.get<HTMLInputElement>("#contact-name").element.value).toBe(
      "",
    );
    wrapper.unmount();
  });

  it("clears the honeypot itself so a stray autofill doesn't swallow every later real attempt", async () => {
    mockedSubmitNetlifyForm.mockResolvedValue(undefined);
    const wrapper = mount(ContactForm);
    // Simulates a browser extension/password manager filling every input on
    // the page, including the hidden honeypot, on load — not a real bot.
    await wrapper.find("#contact-honeypot").setValue("autofilled by mistake");
    await wrapper.find("form").trigger("submit");
    await flushPromises();
    expect(mockedSubmitNetlifyForm).not.toHaveBeenCalled();

    await fillAndSubmit(wrapper, {
      name: "Ada",
      email: "ada@example.com",
      message: "hello",
    });
    expect(mockedSubmitNetlifyForm).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("submits a blank optional name as an empty string rather than omitting it", async () => {
    mockedSubmitNetlifyForm.mockResolvedValue(undefined);
    const wrapper = mount(ContactForm);

    await fillAndSubmit(wrapper, {
      email: "ada@example.com",
      message: "hello",
    });

    expect(mockedSubmitNetlifyForm).toHaveBeenCalledWith({
      formName: "contact",
      fields: { name: "", email: "ada@example.com", message: "hello" },
    });
    wrapper.unmount();
  });

  it("clears the alert once a retry after a failure succeeds", async () => {
    mockedSubmitNetlifyForm.mockRejectedValueOnce(new Error("network down"));
    const wrapper = mount(ContactForm);
    await fillAndSubmit(wrapper, {
      name: "Ada",
      email: "ada@example.com",
      message: "hello",
    });
    expect(wrapper.get('[role="alert"]').text()).not.toBe("");

    mockedSubmitNetlifyForm.mockResolvedValueOnce(undefined);
    await fillAndSubmit(wrapper, {
      name: "Ada",
      email: "ada@example.com",
      message: "hello again",
    });

    expect(wrapper.get('[role="alert"]').text()).toBe("");
    expect(wrapper.get('[role="status"]').text()).not.toBe("");
    wrapper.unmount();
  });
});
