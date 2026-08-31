import { Suspense } from "react";
import { ProjectPanels } from "./project-panels";

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ projectId: string }>;
}) {
  const { projectId } = await params;
  return (
    <Suspense fallback={null}>
      <ProjectPanels projectId={projectId} />
    </Suspense>
  );
}
