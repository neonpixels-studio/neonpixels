<script setup lang="ts">
import { useData } from "vitepress";
import NeonPixelsPage from "./components/NeonPixelsPage.vue";
import NotFound from "./components/NotFound.vue";

const { page } = useData();
</script>

<template>
  <NotFound v-if="page.isNotFound" />
  <NeonPixelsPage v-else />
</template>
