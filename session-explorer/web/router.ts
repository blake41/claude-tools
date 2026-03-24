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

const routeTree = rootRoute.addChildren([
  indexRoute,
  workspaceRoute,
  sessionRoute,
  tagRoute,
  fileRoute,
  askRoute,
  searchRoute,
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
