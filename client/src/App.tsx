import { RouterProvider } from "react-router-dom";
import { AuthProvider } from "@/lib/auth-context";
import { router } from "@/lib/routes";

function App() {
  return (
    <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
  );
}

export default App;
