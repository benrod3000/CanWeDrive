export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Database = {
  public: {
    Functions: {
      road_segments_near_route: {
        Args: {
          max_distance_meters?: number;
          route_geojson: Json;
        };
        Returns: Array<{
          id: number;
          osm_id: number | null;
          name: string | null;
          highway_type: string;
          maxspeed_mph: number | null;
          oneway: boolean | null;
          access: string | null;
          lsv_status: string;
          speed_source: string | null;
          speed_verified_at: string | null;
          distance_meters: number;
          geom_geojson: Json;
        }>;
      };
    };
  };
};
