update public.road_edges
set lsv_status='verified_blocked',
    lsv_reason='explicit restricted access',
    updated_at=now()
where highway_type='service'
  and coalesce(access,'') in ('private','permit','no')
  and lsv_status='unknown';
