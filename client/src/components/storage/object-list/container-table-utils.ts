export const getColumnWidth = (index: number) => {
  switch (index) {
    case 0:
      return "w-[250px] min-w-[250px] max-w-[250px]"; // Location name
    case 1:
      return "w-[200px] min-w-[200px] max-w-[200px]"; // Last Modified
    case 2:
      return "w-[140px] min-w-[140px] max-w-[140px]"; // Lease Status
    case 3:
      return "w-[120px] min-w-[120px] max-w-[120px]"; // Access Level
    case 4:
      return "w-[140px] min-w-[140px] max-w-[140px]"; // Metadata
    case 5:
      return "w-[180px] min-w-[180px] max-w-[180px]"; // Actions
    default:
      return "";
  }
};
