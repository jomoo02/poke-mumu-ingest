import { Suspense } from "react";
import { createClient } from "../lib/supabase/client";

async function PageFetch() {
  const supabase = createClient();

  const { data, error } = await supabase.from("poke").select("*");

  if (!data) {
    return <div>null</div>;
  }

  return <div>{data[0].name_ko}1</div>;
}

export default async function Page() {
  return (
    <Suspense>
      <PageFetch />
    </Suspense>
  );
}
