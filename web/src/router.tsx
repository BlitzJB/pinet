import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Root } from "./routes/root";
import { WelcomePage } from "./routes/welcome";
import { SessionPage } from "./routes/session";
import { SettingsPage } from "./routes/settings";
import { StatusPage } from "./routes/status";

const rootRoute = createRootRoute({ component: Root });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: WelcomePage });
const sessionRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/s/$sessionId",
  component: SessionPage,
  // Side panes live in the URL so a split survives reload and can be shared.
  validateSearch: (search: Record<string, unknown>): { side?: string } =>
    typeof search.side === "string" && search.side ? { side: search.side } : {},
});
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });
// A board for a screen that is left on, so it is a route rather than a mode.
const statusRoute = createRoute({ getParentRoute: () => rootRoute, path: "/status", component: StatusPage });

const routeTree = rootRoute.addChildren([indexRoute, sessionRoute, settingsRoute, statusRoute]);

export const router = createRouter({ routeTree, basepath: "/app" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
