<script setup lang="ts">
import { computed, nextTick, reactive, ref } from "vue";
import { WORDMARK_GRADIENT } from "../brand";
import { submitNetlifyForm } from "../forms/submitNetlifyForm";

// Netlify's build-time bot registers a form by statically parsing the built
// HTML for a <form data-netlify="true"> with this name; the hidden
// "form-name" input below carries the same value so a real submission (via
// fetch, here) can be tied back to that registration. Both must ship exactly
// as static markup — neither can be injected after the fact by client JS, or
// the bot never sees them.
const FORM_NAME = "contact";
const HONEYPOT_FIELD_NAME = "bot-field";

// Shared by every visible field (name/email/message) so the two style
// concerns — the uppercase micro-label and the input/textarea chrome — are
// each defined once rather than repeated per field.
const FIELD_LABEL_CLASS =
  "text-fg-dim text-[10.5px] tracking-[0.14em] uppercase";
const FIELD_CONTROL_CLASS =
  "border-border bg-bg text-fg user-invalid:border-pink aria-invalid:border-pink rounded-none border px-3 py-2 text-[13px]";
const FIELD_ERROR_CLASS = "text-pink m-0 min-h-[1em] text-[12px]";

// Intentionally permissive (matches what the browser's own type="email"
// check accepts closely enough): the server/Netlify is the real gate, this
// only catches obvious typos before a round trip.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/;

type SubmitStatus = "idle" | "submitting" | "success" | "error";

const fields = reactive({ name: "", email: "", message: "" });
// Spam trap: real visitors never see or reach this field (hidden from sighted
// users and assistive tech alike, and out of the tab order), so a bot that
// blindly fills every input it finds outs itself by populating it.
const honeypotValue = ref("");
const status = ref<SubmitStatus>("idle");

// Errors only surface once a field has been blurred or a submit was
// attempted, so an untouched form never opens flagged as invalid (the same
// guarantee :user-invalid gives natively, but for browsers lacking it).
const touched = reactive({ email: false, message: false });

const emailError = computed(() => {
  if (!touched.email) {
    return "";
  }
  if (!fields.email.trim()) {
    return "Enter your email address.";
  }
  return EMAIL_PATTERN.test(fields.email.trim())
    ? ""
    : "Enter a valid email address, like name@example.com.";
});
const messageError = computed(() =>
  touched.message && !fields.message.trim() ? "Enter a message." : "",
);

// A screen reader can miss a live region that appears in the DOM at the same
// moment as the text it's meant to announce (NVDA/VoiceOver commonly do). The
// template keeps one status paragraph and one alert paragraph always mounted
// and toggles only their text/visibility via these computeds, so the region
// itself is never inserted fresh alongside its content.
const statusMessage = computed(() =>
  status.value === "success"
    ? "Thanks — that landed. I'll get back to you soon."
    : "",
);
const errorMessage = computed(() =>
  status.value === "error"
    ? "That didn't send. Please try again in a moment."
    : "",
);

function resetFields() {
  fields.name = "";
  fields.email = "";
  fields.message = "";
  touched.email = false;
  touched.message = false;
}

function touchRequiredFields() {
  touched.email = true;
  touched.message = true;
}

function hasFieldErrors() {
  return Boolean(emailError.value || messageError.value);
}

function focusFirstInvalidField() {
  const selector = emailError.value ? "#contact-email" : "#contact-message";
  document.querySelector<HTMLElement>(selector)?.focus();
}

async function handleSubmit() {
  // Guards against a duplicate in-flight submission: the button is disabled
  // while submitting, but pressing Enter in a text field re-fires the form's
  // submit event directly and bypasses that. Without this, a second Enter
  // press mid-request would fire a second real POST.
  if (status.value === "submitting") {
    return;
  }
  if (honeypotValue.value) {
    // Report success without actually submitting, so a bot gets no signal
    // that it was caught rather than that the form is simply broken. Also
    // clears the honeypot itself: a stray autofill (some browser extensions
    // fill every input on a page, hidden or not) would otherwise silently
    // swallow every subsequent real attempt from this same visitor too.
    status.value = "success";
    resetFields();
    honeypotValue.value = "";
    return;
  }
  touchRequiredFields();
  if (hasFieldErrors()) {
    await nextTick();
    focusFirstInvalidField();
    return;
  }
  status.value = "submitting";
  try {
    await submitNetlifyForm({ formName: FORM_NAME, fields: { ...fields } });
    status.value = "success";
    resetFields();
  } catch (error) {
    console.error("Contact form submission failed", error);
    status.value = "error";
  }
}
</script>

<template>
  <div
    id="contact"
    class="border-border bg-panel relative z-[2] border-t px-10 py-10"
  >
    <div
      class="mx-auto flex max-w-[1180px] flex-col gap-6 lg:flex-row lg:items-start lg:justify-between lg:gap-14"
    >
      <div class="flex max-w-[360px] flex-col gap-[10px]">
        <!-- A real heading (rather than another styled div, as the other
             section eyebrows use) so the form has an accessible name
             reachable by heading-navigation, not just visually implied. -->
        <h2
          class="m-0 flex items-center gap-3 text-[11.5px] tracking-[0.24em] text-[#7a7a85] uppercase"
        >
          <span class="h-px w-[22px] bg-[#7a7a85]" />
          get in touch
        </h2>
        <p class="text-fg-muted m-0 text-[13.5px] leading-[1.7]">
          Hiring, collaborating, or something's broken? Send a note — someone
          (well, one and a half someones) reads every one.
        </p>
      </div>

      <form
        :name="FORM_NAME"
        method="POST"
        data-netlify="true"
        novalidate
        :data-netlify-honeypot="HONEYPOT_FIELD_NAME"
        class="flex flex-1 flex-col gap-3 lg:max-w-[620px]"
        @submit.prevent="handleSubmit"
      >
        <!-- Required verbatim so Netlify's build-time bot can associate a
             runtime submission with the form it parsed from the static HTML. -->
        <input type="hidden" name="form-name" :value="FORM_NAME" />

        <!-- Honeypot: visually hidden (`hidden`), removed from the
             accessibility tree (aria-hidden), and out of the tab order
             (tabindex="-1") so no real visitor — sighted or using assistive
             tech — can ever reach or perceive it. -->
        <p class="hidden" aria-hidden="true">
          <label for="contact-honeypot">
            Leave this field blank
            <input
              id="contact-honeypot"
              v-model="honeypotValue"
              :name="HONEYPOT_FIELD_NAME"
              tabindex="-1"
              autocomplete="off"
            />
          </label>
        </p>

        <div class="flex flex-col gap-3 sm:flex-row">
          <label for="contact-name" class="flex flex-col gap-[6px] sm:flex-1">
            <span :class="FIELD_LABEL_CLASS">name</span>
            <input
              id="contact-name"
              v-model="fields.name"
              type="text"
              name="name"
              autocomplete="name"
              :class="FIELD_CONTROL_CLASS"
            />
          </label>
          <label for="contact-email" class="flex flex-col gap-[6px] sm:flex-1">
            <span :class="FIELD_LABEL_CLASS">email</span>
            <input
              id="contact-email"
              v-model="fields.email"
              type="email"
              name="email"
              required
              autocomplete="email"
              :aria-invalid="emailError ? 'true' : undefined"
              :aria-describedby="emailError ? 'contact-email-error' : undefined"
              :class="FIELD_CONTROL_CLASS"
              @blur="touched.email = true"
            />
            <span id="contact-email-error" :class="FIELD_ERROR_CLASS">{{
              emailError
            }}</span>
          </label>
        </div>

        <label for="contact-message" class="flex flex-col gap-[6px]">
          <span :class="FIELD_LABEL_CLASS">message</span>
          <textarea
            id="contact-message"
            v-model="fields.message"
            name="message"
            rows="3"
            required
            :aria-invalid="messageError ? 'true' : undefined"
            :aria-describedby="
              messageError ? 'contact-message-error' : undefined
            "
            :class="FIELD_CONTROL_CLASS"
            @blur="touched.message = true"
          />
          <span id="contact-message-error" :class="FIELD_ERROR_CLASS">{{
            messageError
          }}</span>
        </label>

        <div class="flex flex-wrap items-center gap-4">
          <button
            type="submit"
            :disabled="status === 'submitting'"
            class="text-bg animate-sweep rounded-none px-5 py-[9px] text-[13px] font-bold disabled:opacity-60"
            :style="{ backgroundImage: WORDMARK_GRADIENT }"
          >
            {{ status === "submitting" ? "sending…" : "send message" }}
          </button>
          <!-- Both regions stay mounted for the whole component lifetime and
               only their text changes: a live region inserted into the DOM at
               the same moment as the content it announces is commonly missed
               by screen readers (NVDA/VoiceOver), so toggling with v-if here
               would defeat the announcement rather than just look odd. -->
          <p
            role="status"
            aria-live="polite"
            class="text-lime m-0 text-[12.5px]"
          >
            {{ statusMessage }}
          </p>
          <p role="alert" class="text-pink m-0 text-[12.5px]">
            {{ errorMessage }}
          </p>
        </div>
      </form>
    </div>
  </div>
</template>
