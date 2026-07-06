import { RouterProvider } from "react-router-dom";
import { AuthProvider } from "@/lib/auth-context";
import { router } from "@/lib/routes";
import { Toaster } from "@/components/ui/sonner";
import { ServerReadyGate } from "@/components/server-ready-gate";

function App() {
  return (
    <ServerReadyGate>
      <AuthProvider>
        <RouterProvider router={router} />
        <Toaster />
      </AuthProvider>
    </ServerReadyGate>
  );
}

export default App;
