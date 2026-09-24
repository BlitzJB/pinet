import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Root } from "./routes/root";
import { WelcomePage } from "./routes/welcome";
import { SessionPage } from "./routes/session";
import { SettingsPage } from "./routes/settings";

const rootRoute = createRootRoute({ component: Root });

const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: WelcomePage });
const sessionRoute = createRoute({ getParentRoute: () => rootRoute, path: "/s/$sessionId", component: SessionPage });
const settingsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/settings", component: SettingsPage });

const routeTree = rootRoute.addChildren([indexRoute, sessionRoute, settingsRoute]);

export const router = createRouter({ routeTree, basepath: "/app" });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
