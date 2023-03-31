import React from "react";
import { render } from "@testing-library/react";
import AdminAddOrganization from "./AdminAddOrganization";
import { Provider } from "react-redux";
import { setupStore } from "../../store";

it("should take a snapshot", () => {
  const { asFragment } = render(
    <Provider store={setupStore({})}>
      <AdminAddOrganization />
    </Provider>
  );

  expect(
    asFragment(
      <Provider store={setupStore({})}>
        <AdminAddOrganization />
      </Provider>
    )
  ).toMatchSnapshot();
});
