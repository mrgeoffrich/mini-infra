import React from "react";
import { Container } from "lucide-react";
import { CopyButton } from "./CopyButton";

interface ContainerNameCellProps {
  name: string;
}

export const ContainerNameCell = React.memo(
  ({ name }: ContainerNameCellProps) => (
    <div className="flex items-center gap-2 min-h-[2rem]">
      <Container className="h-4 w-4 text-blue-600 shrink-0" />
      <span className="font-medium truncate flex-1">{name}</span>
      <CopyButton text={name} />
    </div>
  ),
  (prevProps, nextProps) => prevProps.name === nextProps.name,
);

ContainerNameCell.displayName = "ContainerNameCell";
