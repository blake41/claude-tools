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

export interface LibrarySearch {
  type?: string;
  scope?: string;
  ns?: string;
  q?: string;
  sort?: string;
  include_plugins?: boolean;
}

export const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  validateSearch: (search: Record<string, unknown>): LibrarySearch => ({
    type: (search.type as string) || undefined,
    scope: (search.scope as string) || undefined,
    ns: (search.ns as string) || undefined,
    q: (search.q as string) || undefined,
    sort: (search.sort as string) || undefined,
    include_plugins: search.include_plugins === true || search.include_plugins === "true",
  }),
});

export const libraryDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library/$id",
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
  libraryRoute,
  libraryDetailRoute,
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
