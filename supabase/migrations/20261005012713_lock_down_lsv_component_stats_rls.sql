ALTER TABLE public.lsv_component_stats ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lsv_component_stats FROM anon, authenticated;
