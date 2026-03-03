import { RouterProvider } from "react-router-dom";
import { AuthProvider } from "@/lib/auth-context";
import { router } from "@/lib/routes";
import { Toaster } from "@/components/ui/sonner";

function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
      <Toaster />
    </AuthProvider>
  );
}

export default App;
