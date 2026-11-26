<script setup lang="ts">
import { computed } from "vue";
import type { Project } from "../data/projects";
import { projectStyleClass } from "../generatedStyles";
import ProjectSummary from "./ProjectSummary.vue";

// `reverse` puts the bespoke visual on the left and the summary on the right.
// It alternates per section, so the page derives it from the loop index.
const props = defineProps<{ project: Project; reverse?: boolean }>();

const gridColumns = computed(() => {
  if (props.reverse) {
    return "md:grid-cols-[minmax(0,1fr)_minmax(0,0.72fr)]";
  }
  return "md:grid-cols-[minmax(0,0.72fr)_minmax(0,1fr)]";
});
</script>

<template>
  <section
    :id="project.id"
    class="border-border relative z-[2] overflow-hidden border-t px-10 py-[76px]"
    :class="projectStyleClass(project.id, 'section')"
  >
    <div
      class="absolute top-0 right-0 left-0 h-px"
      :class="projectStyleClass(project.id, 'top-line')"
    />
    <div
      class="ambient-decoration pointer-events-none absolute rounded-full blur-[46px]"
      :class="[
        project.section.aurora.animation,
        project.section.aurora.position,
        project.section.aurora.size,
        projectStyleClass(project.id, 'aurora'),
      ]"
    />
    <div
      class="relative mx-auto grid max-w-[1180px] items-center gap-14"
      :class="gridColumns"
    >
      <template v-if="reverse">
        <slot name="visual" />
        <ProjectSummary :project="project" />
      </template>
      <template v-else>
        <ProjectSummary :project="project" />
        <slot name="visual" />
      </template>
    </div>
  </section>
</template>
