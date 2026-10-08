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

  it("logs a non-PII console.info marker when the honeypot catches a submission", async () => {
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const wrapper = mount(ContactForm);
    await fillFields(wrapper, { name: "Ada", email: "ada@example.com" });
    await wrapper.find("#contact-honeypot").setValue("spam bot filled this");
    await wrapper.find("form").trigger("submit");
    await flushPromises();

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const loggedText = JSON.stringify(infoSpy.mock.calls);
    expect(loggedText).toContain("honeypot");
    expect(loggedText).not.toContain("Ada");
    expect(loggedText).not.toContain("ada@example.com");
    expect(loggedText).not.toContain("spam bot filled this");
    infoSpy.mockRestore();
    wrapper.unmount();
  });

  it("does not log the honeypot marker for a real submission", async () => {
    mockedSubmitNetlifyForm.mockResolvedValue(undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const wrapper = mount(ContactForm);
    await fillAndSubmit(wrapper, {
      name: "Ada",
      email: "ada@example.com",
      message: "hello",
    });

    expect(infoSpy).not.toHaveBeenCalled();
    infoSpy.mockRestore();
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

  describe("invalid state", () => {
    it("only disables native validation once hydrated, so the no-JS post stays validated", async () => {
      const wrapper = mount(ContactForm);
      await flushPromises();
      expect(wrapper.get("form").attributes("novalidate")).toBeDefined();
      wrapper.unmount();
    });

    it("shows no errors on the freshly cleared form after a successful send", async () => {
      mockedSubmitNetlifyForm.mockResolvedValue(undefined);
      const resetSpy = vi.spyOn(HTMLFormElement.prototype, "reset");
      const wrapper = mount(ContactForm);
      await fillFields(wrapper, {
        email: "ada@example.com",
        message: "hello",
      });
      await wrapper.get("#contact-email").trigger("blur");
      await wrapper.get("#contact-message").trigger("blur");
      await wrapper.find("form").trigger("submit");
      await flushPromises();
      expect(resetSpy).toHaveBeenCalledTimes(1);
      resetSpy.mockRestore();
      expect(wrapper.get("#contact-email-error").text()).toBe("");
      expect(wrapper.get("#contact-message-error").text()).toBe("");
      expect(wrapper.get("#contact-email").attributes("aria-invalid")).toBe(
        undefined,
      );
      wrapper.unmount();
    });

    it("announces field errors politely", () => {
      const wrapper = mount(ContactForm);
      expect(wrapper.get("#contact-email-error").attributes("aria-live")).toBe(
        "polite",
      );
      expect(
        wrapper.get("#contact-message-error").attributes("aria-live"),
      ).toBe("polite");
      wrapper.unmount();
    });

    it("keeps the error text out of the field's label so the accessible name stays clean", async () => {
      const wrapper = mount(ContactForm);
      await wrapper.get("#contact-email").trigger("blur");
      const label = wrapper.get('label[for="contact-email"]');
      expect(label.text()).toBe("email");
      wrapper.unmount();
    });

    it("flags a whitespace-only message", async () => {
      const wrapper = mount(ContactForm);
      await wrapper.get("#contact-message").setValue("   ");
      await wrapper.get("#contact-message").trigger("blur");
      expect(wrapper.get("#contact-message-error").text()).toBe(
        "Enter a message.",
      );
      wrapper.unmount();
    });

    it("focuses the message when only it is invalid, and sends nothing", async () => {
      const wrapper = mount(ContactForm, { attachTo: document.body });
      await fillFields(wrapper, { email: "ada@example.com" });
      await wrapper.find("form").trigger("submit");
      await flushPromises();
      expect(mockedSubmitNetlifyForm).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(
        wrapper.get("#contact-message").element,
      );
      wrapper.unmount();
    });

    it("submits once the visitor fixes the fields after a blocked attempt, with a trimmed email", async () => {
      mockedSubmitNetlifyForm.mockResolvedValue(undefined);
      const wrapper = mount(ContactForm);
      await wrapper.find("form").trigger("submit");
      await fillAndSubmit(wrapper, {
        email: " ada@example.com ",
        message: "hello",
      });
      expect(mockedSubmitNetlifyForm).toHaveBeenCalledTimes(1);
      expect(mockedSubmitNetlifyForm).toHaveBeenCalledWith({
        formName: "contact",
        fields: { name: "", email: "ada@example.com", message: "hello" },
      });
      wrapper.unmount();
    });

    it("does not flag required fields before the visitor interacts", () => {
      const wrapper = mount(ContactForm);
      expect(wrapper.get("#contact-email").attributes("aria-invalid")).toBe(
        undefined,
      );
      expect(wrapper.get("#contact-message").attributes("aria-invalid")).toBe(
        undefined,
      );
      expect(wrapper.get("#contact-email-error").text()).toBe("");
      wrapper.unmount();
    });

    it("flags a blurred empty email and associates the error via aria-describedby", async () => {
      const wrapper = mount(ContactForm);
      await wrapper.get("#contact-email").trigger("blur");
      const email = wrapper.get("#contact-email");
      expect(email.attributes("aria-invalid")).toBe("true");
      expect(email.attributes("aria-describedby")).toBe("contact-email-error");
      expect(wrapper.get("#contact-email-error").text()).toBe(
        "Enter your email address.",
      );
      wrapper.unmount();
    });

    it("rejects a malformed email and clears the error once it is fixed", async () => {
      const wrapper = mount(ContactForm);
      await wrapper.get("#contact-email").setValue("not-an-email");
      await wrapper.get("#contact-email").trigger("blur");
      expect(wrapper.get("#contact-email-error").text()).toContain("valid");
      await wrapper.get("#contact-email").setValue("ada@example.com");
      expect(wrapper.get("#contact-email").attributes("aria-invalid")).toBe(
        undefined,
      );
      expect(wrapper.get("#contact-email-error").text()).toBe("");
      wrapper.unmount();
    });

    it("blocks submission, flags both required fields, and sends nothing", async () => {
      const wrapper = mount(ContactForm, { attachTo: document.body });
      await wrapper.find("form").trigger("submit");
      await flushPromises();

      expect(mockedSubmitNetlifyForm).not.toHaveBeenCalled();
      expect(wrapper.get("#contact-email").attributes("aria-invalid")).toBe(
        "true",
      );
      const message = wrapper.get("#contact-message");
      expect(message.attributes("aria-invalid")).toBe("true");
      expect(message.attributes("aria-describedby")).toBe(
        "contact-message-error",
      );
      expect(wrapper.get("#contact-message-error").text()).toBe(
        "Enter a message.",
      );
      expect(document.activeElement).toBe(
        wrapper.get("#contact-email").element,
      );
      wrapper.unmount();
    });
  });
});
