import { createRouter, createRootRouteWithContext, createRoute } from "@tanstack/react-router";

export interface RouterContext {
  // empty — we don't need beforeLoad context for now
}

export const rootRoute = createRootRouteWithContext<RouterContext>()({});

export const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
});

export const workspaceRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/workspace/$id",
});

export const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/session/$id",
  validateSearch: (search: Record<string, unknown>): { msg?: string } => ({
    msg: (search.msg as string) || undefined,
  }),
});

export const tagRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tag/$name",
});

export const fileRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/file",
  validateSearch: (search: Record<string, unknown>) => ({
    path: (search.path as string) || "",
  }),
});

export const askRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/ask",
});

export const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/search",
});

export const insightsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/insights",
});

export const metaRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/meta",
});

export const metaProposalsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/meta/proposals",
  validateSearch: (search: Record<string, unknown>): { type?: string } => ({
    type: (search.type as string) || undefined,
  }),
});

export const metaProposalDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/meta/proposals/$id",
});

export const metaScoresRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/meta/scores",
});

export const metaSettingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/meta/settings",
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  workspaceRoute,
  sessionRoute,
  tagRoute,
  fileRoute,
  askRoute,
  searchRoute,
  insightsRoute,
  metaRoute,
  metaProposalsRoute,
  metaProposalDetailRoute,
  metaScoresRoute,
  metaSettingsRoute,
]);

export const router = createRouter({
  routeTree,
  context: {},
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
