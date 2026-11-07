import { createFileRoute } from "@tanstack/react-router";
import { FathomApp } from "@/components/fathom-app";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <FathomApp />;
}
