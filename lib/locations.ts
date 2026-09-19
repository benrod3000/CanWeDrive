export type PlaceId = "carlsbad-village" | "encinitas" | "oceanside-harbor";

export type Place = {
  id: PlaceId;
  name: string;
  coordinates: [number, number];
};

export const PLACES: Place[] = [
  {
    id: "carlsbad-village",
    name: "Carlsbad Village",
    coordinates: [-117.3506, 33.1581],
  },
  {
    id: "encinitas",
    name: "Encinitas",
    coordinates: [-117.2919, 33.0370],
  },
  {
    id: "oceanside-harbor",
    name: "Oceanside Harbor",
    coordinates: [-117.3420, 33.2072],
  },
];

export function getPlace(id: string) {
  return PLACES.find((place) => place.id === id);
}
