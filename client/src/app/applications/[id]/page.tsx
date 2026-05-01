import { Navigate, useParams } from "react-router-dom";

export default function ApplicationDetailIndex() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/applications" replace />;
  return <Navigate to={`/applications/${id}/overview`} replace />;
}
