import { createAsyncThunk, createSlice, PayloadAction, ThunkDispatch } from '@reduxjs/toolkit'
import { RootState } from '../store'
import MessageMonitorApi from '../apis/mm-api'
import { selectToken } from './userSlice'

export const initialState = {
  intersections: [] as IntersectionReferenceData[],
  selectedIntersection: null as IntersectionReferenceData | null,
  selectedRoadRegulatorId: -1,
  selectedIntersectionId: -1,
}

export const getIntersections = createAsyncThunk(
  'intersection/getIntersections',
  async (_, { getState }) => {
    const currentState = getState() as RootState
    const authToken = selectToken(currentState)!

    const intersections = await MessageMonitorApi.getIntersections({ token: authToken })
    intersections.push({
      intersectionID: -1,
      roadRegulatorID: -1,
      rsuIP: '0.0.0.0',
      latitude: 0,
      longitude: 0,
    })
    return intersections
  },
  {
    condition: (_, { getState }) => selectToken(getState() as RootState) != undefined,
  }
)

export const intersectionSlice = createSlice({
  name: 'intersection',
  initialState: {
    loading: false,
    value: initialState,
  },
  reducers: {
    setSelectedIntersection: (state, action: PayloadAction<number>) => {
      const intersection = state.value.intersections.find((i) => i.intersectionID === action.payload)
      if (intersection) {
        state.value.selectedIntersection = intersection
        state.value.selectedIntersectionId = action.payload
      } else {
        console.error('Intersection ' + action.payload + ' not found in list:', state.value.intersections)
      }
    },
    setSelectedIntersectionId: (state, action: PayloadAction<number>) => {
      state.value.selectedIntersectionId = action.payload
    },
    setSelectedRoadRegulatorId: (state, action: PayloadAction<number>) => {
      state.value.selectedRoadRegulatorId = action.payload
    },
    setIntersectionManual: (state, action: PayloadAction<IntersectionReferenceData>) => {
      state.value.intersections = [action.payload]
      state.value.selectedIntersection = action.payload
      state.value.selectedIntersectionId = action.payload[0].intersectionID
      state.value.selectedRoadRegulatorId = action.payload[0].roadRegulatorID
    },
  },
  extraReducers: (builder) => {
    builder
      .addCase(getIntersections.pending, (state) => {
        state.loading = true
      })
      .addCase(getIntersections.fulfilled, (state, action: PayloadAction<IntersectionReferenceData[]>) => {
        state.value.intersections = action.payload
        state.loading = false
      })
      .addCase(getIntersections.rejected, (state) => {
        state.loading = false
      })
  },
})

export const selectIntersections = (state: RootState) => state.intersection.value.intersections
export const selectSelectedIntersection = (state: RootState) => state.intersection.value.selectedIntersection
export const selectSelectedIntersectionId = (state: RootState) => state.intersection.value.selectedIntersectionId
export const selectSelectedRoadRegulatorId = (state: RootState) => state.intersection.value.selectedRoadRegulatorId

export const { setSelectedIntersection, setSelectedIntersectionId, setSelectedRoadRegulatorId } =
  intersectionSlice.actions

export default intersectionSlice.reducer
